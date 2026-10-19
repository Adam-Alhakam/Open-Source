/* This Source Code Form is subject to the terms of the Mozilla Public
* License, v. 2.0. If a copy of the MPL was not distributed with this
* file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const DateHolidays = require('date-holidays');
const Week = require('../../models/Week');
const HolidayGroupMember = require('../../models/HolidayGroupMember');
const { getRruleDate } = require('./generateRrule');
const { log } = require('../../log');
const moment = require('moment');
const Holidays = DateHolidays.default || DateHolidays;

/**
 * Creates a date-holidays provider from an OED location.
 * OED stores holiday locations in one of these forms:
 * US, US-CA or US-CA-LA
 * @param {string} location The holiday location stored by OED.
 * @returns {Holidays} A configured date-holidays provider.
 */
function createHolidayProvider(location) {
	// OED stores the location hierarchy in one hyphen-separated value.
	const locationParts = String(location).split('-');
	const country = locationParts[0];
	const state = locationParts[1];
	const region = locationParts[2];
	let holidayProvider;

	if (region) {
		holidayProvider = new Holidays(country, state, region);
	} else if (state) {
		holidayProvider = new Holidays(country, state);
	} else if (country) {
		holidayProvider = new Holidays(country);
	} else {
		const errMsg = 'Cannot resolve a holiday without a location.';
		log.error(errMsg);
		throw new Error(errMsg);
	}

	return holidayProvider;
}

/**
 * Returns the calendar years that overlap the Conversion Segment.
 * Both boundary years are checked because the segment may contain only part
 * of its first or last year. Holiday dates outside the exact segment range
 * are removed later.
 *
 * @param {string} startDateKey Inclusive start date in YYYY-MM-DD format.
 * @param {string} endDateKey Exclusive end date in YYYY-MM-DD format.
 * @returns {Array<number>} The calendar years in the range.
 */
function getYearsInRange(startDateKey, endDateKey) {
	const startYear = moment.utc(startDateKey, 'YYYY-MM-DD', true).year();
	const endYear = moment.utc(endDateKey, 'YYYY-MM-DD', true).year();
	const years = [];

	for (let year = startYear; year <= endYear; year += 1) {
		years.push(year);
	}

	return years;
}

/**
 * Converts a Conversion Segment boundary into a YYYY-MM-DD date.
 *
 * This uses the same -infinity and infinity handling as the existing RRule
 * code. Patterned Conversion Segment boundaries are expected to be at
 * midnight.
 *
 * @param {*} value The Conversion Segment boundary.
 * @returns {string} The normalized date in YYYY-MM-DD format.
 */
function getDateKey(value) {
	return moment.utc(getRruleDate(value)).format('YYYY-MM-DD');
}

/**
 * Gets the holiday replacements for a Week Pattern inside a Conversion
 * Segment date range.
 *
 * The returned Map is keyed by the holiday's YYYY-MM-DD calendar date. Its
 * value identifies the Day Pattern that should eventually replace the normal
 * weekly pattern on that date.
 *
 * This function only resolves holiday dates. It does not change RRule
 * occurrences or create concrete Conversion Segments.
 *
 * @param {*} weekId The Week Pattern ID.
 * @param {*} startDate Inclusive Conversion Segment start date.
 * @param {*} endDate Exclusive Conversion Segment end date.
 * @param {*} conn The database connection to use.
 * @returns {Promise<Map<string, Object>>} Holiday replacements sorted by date.
 */
async function getHolidayReplacements(weekId, startDate, endDate, conn) {
	const startDateKey = getDateKey(startDate);
	const endDateKey = getDateKey(endDate);
	// Holiday replacements require at least one full calendar day.
	if (startDateKey >= endDateKey) {
		const errMsg =
			`Holiday replacement range for Week Pattern ${weekId} must have ` +
			`a start before its end: ${startDate} to ${endDate}.`;

		log.error(errMsg);
		throw new Error(errMsg);
	}

	// The Week Pattern stores the optional Holiday Instance Group ID.
	const week = await Week.getById(weekId, conn);

	let members = [];

	// Only load Holiday Rates when the Week Pattern has a Holiday Rate Group.
	if (week.holidayInstanceGroupId != null) {
		members = await HolidayGroupMember.getByGroupId(week.holidayInstanceGroupId, conn);
	}

	// A missing or empty Holiday Rate Group leaves the normal weekly pattern unchanged.
	if (members.length === 0) {
		return new Map();
	}

	const years = getYearsInRange(startDateKey, endDateKey);

	// date-holidays returns every holiday for one location and year. Cache that
	// result so multiple configured holidays at the same location do not cause
	// repeated provider calls.
	// Maps are used instead of Sets because each unique key must also store a
	// reusable value: a location maps to its provider, and a location/year maps
	// to the holiday records returned by that provider.
	const providersByLocation = new Map();
	const holidaysByLocationAndYear = new Map();

	// Keyed by YYYY-MM-DD so that next step can efficiently check whether an
	// RRule occurrence is a configured holiday.
	const replacements = new Map();

	for (const member of members) {
		const location = member.location;
		const holidayName = member.holiday_name;

		if (!location) {
			const errMsg =
				`Cannot resolve holiday "${holidayName}" because it has no location.`;
			log.error(errMsg);
			throw new Error(errMsg);
		}

		if (!providersByLocation.has(location)) {
			providersByLocation.set(
				location,
				createHolidayProvider(location)
			);
		}

		const provider = providersByLocation.get(location);

		for (const year of years) {
			const providerCacheKey = `${location}:${year}`;

			if (!holidaysByLocationAndYear.has(providerCacheKey)) {
				let providerHolidays;

				try {
					providerHolidays = provider.getHolidays(year, 'en');
				} catch (error) {
					const errMsg =
						`Unable to resolve holidays for ${location} in ${year}: ` +
						error.message;
					log.error(errMsg);
					throw new Error(errMsg);
				}

				holidaysByLocationAndYear.set(
					providerCacheKey,
					providerHolidays
				);
			}

			const providerHolidays = holidaysByLocationAndYear.get(
				providerCacheKey
			);

			// Use an exact match so similar names such as "Thanksgiving Day" and
			// "Day after Thanksgiving Day" are not confused.
			const match = providerHolidays.find(
				holiday => holiday.name === holidayName
			);

			// Substitute holidays may not occur every year, so no exact match is valid.
			if (match !== undefined) {
				// OED holiday exceptions replace a full calendar day, so provider times
				// such as Halloween beginning at 18:00 are intentionally ignored.
				const parsedHolidayDate = moment.utc(
					String(match.date).slice(0, 10),
					'YYYY-MM-DD',
					true
				);

				if (!parsedHolidayDate.isValid()) {
					const errMsg =
						`Holiday provider returned an invalid date for ` +
						`"${holidayName}": ${match.date}`;

					log.error(errMsg);
					throw new Error(errMsg);
				}

				const holidayDate = parsedHolidayDate.format('YYYY-MM-DD');

				// The Conversion Segment range includes its start date but excludes its end date.
				if (holidayDate >= startDateKey && holidayDate < endDateKey) {
					if (replacements.has(holidayDate)) {
						log.warn(
							`Multiple holiday replacements resolved for ` +
							`${holidayDate}; using the first replacement.`
						);
					} else {
						replacements.set(holidayDate, {
							dayPatternId: member.day_pattern_id,
							holidayName,
							holidayInstanceId: member.holiday_instance_id,
							location
						});
					}
				}
			}

			// Return the holiday replacements in calendar-date order.
		}
	}

	return new Map(
		Array.from(replacements.entries()).sort(
			([firstDate], [secondDate]) =>
				firstDate.localeCompare(secondDate)
		)
	);
}

module.exports = {
	getHolidayReplacements
};