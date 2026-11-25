/* This Source Code Form is subject to the terms of the Mozilla Public
* License, v. 2.0. If a copy of the MPL was not distributed with this
* file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const DateHolidays = require('date-holidays');
const moment = require('moment');
const Week = require('../../models/Week');
const HolidayGroupMember = require('../../models/HolidayGroupMember');
const { getRruleDate } = require('./generateRrule');
const { log } = require('../../log');

const Holidays = DateHolidays.default || DateHolidays;

// SHL More commenting within the code lines would be good in some parts where there is none. Mostly it is good.
// Adam: Done — I added comments around the provider caching, exact matching,
// calendar-date handling and half-open range logic.
/**
 * Creates a date-holidays provider from an OED location.
 * OED stores holiday locations in one of these forms:
 * US
 * US-CA
 * US-CA-LA
 * @param {string} location The holiday location stored by OED.
 * @returns {Holidays} A configured date-holidays provider.
 */
function createHolidayProvider(location) {
	// SHL Should be tab not space indented & the formatting is off. I suggest you use VSC format document to do all formatting.
	// Adam: Done — this file now uses tabs and follows the surrounding OED formatting style.
	const locationParts = String(location).split('-');
	const country = locationParts[0];
	const state = locationParts[1];
	const region = locationParts[2];

	// SHL I think the logic could be better. Check each item with if/else if and then the else would be no country error.
	// Also, set a variable with the Holiday for each case and do a single return at the end.
	// Adam: Done — the location cases now use if/else-if and return the configured provider once.
	let holidayProvider;

	if (region) {
		holidayProvider = new Holidays(country, state, region);
	} else if (state) {
		holidayProvider = new Holidays(country, state);
	} else if (country) {
		holidayProvider = new Holidays(country);
	} else {
		// SHL When have an error need to log via OED mechanism and not just throw error.
		// Adam: Done — the error is logged through OED before it is thrown.
		const errMsg = 'Cannot resolve a holiday without a location.';
		log.error(errMsg);
		throw new Error(errMsg);
	}

	return holidayProvider;
}

// SHL I think the document talks about holidays before the start date too. See comment below.
// Adam: Both boundary years are queried, but only holidays inside the half-open
// Conversion Segment range are returned. A holiday before the start is not
// returned because it must not create a segment outside this Conversion Segment.
// Huss, could you confirm whether you meant earlier holidays were needed only
// for RRule context?

/**
 * Returns all calendar years that may contain a holiday inside the requested
 * date range.
 *
 * The end year is included here. Holidays that occur on or after the actual
 * end date are removed later by the half-open range check.
 *
 * @param {string} startDateKey Inclusive start date in YYYY-MM-DD format.
 * @param {string} endDateKey Exclusive end date in YYYY-MM-DD format.
 * @returns {Array<number>} The calendar years in the range.
 */
function getYearsInRange(startDateKey, endDateKey) {
	// SHL I think finding years by manipulating the string to a number is not great. I think we discussed moment that is used by OED. Please switch to that. It may even be able to give you what you want with an interval.
	// Adam: Done — strict UTC Moment parsing is now used to obtain the boundary years.
	const startDate = moment.utc(startDateKey, 'YYYY-MM-DD', true);
	const endDate = moment.utc(endDateKey, 'YYYY-MM-DD', true);

	if (!startDate.isValid() || !endDate.isValid()) {
		const errMsg = `Invalid date range for holiday replacement years: ${startDateKey} to ${endDateKey}.`;
		log.error(errMsg);
		throw new Error(errMsg);
	}

	const startYear = startDate.year();
	const endYear = endDate.year();
	const years = [];

	for (let year = startYear; year <= endYear; year += 1) {
		years.push(year);
	}

	return years;
}

// Should you ever get an error? If not really, then is this name need here or elsewhere?
// Adam: Invalid dates are checked so provider or boundary problems fail clearly.
// The boundaryName parameter was removed because the error now reports the
// invalid value directly.

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
	const date = moment.utc(getRruleDate(value));

	if (!date.isValid()) {
		const errMsg = `Invalid date for holiday replacement lookup: ${value}`;
		log.error(errMsg);
		throw new Error(errMsg);
	}
	// SHL Should see if all these date items can be switched to moment. Will not mark more of them.
	// Adam: Done — getRruleDate still handles infinity boundaries and Moment now formats the UTC date key.
	return date.format('YYYY-MM-DD');
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
// SHL OED does not want parameters spread out but on 1 line when possible. You should look at existing code to see how we do formatting.
// Adam: Done — this file now uses tabs and follows the surrounding OED formatting style.
// Adam: Done — the readable parameter list is now on one line.
async function getHolidayReplacements(weekId, startDate, endDate, conn) {
	const startDateKey = getDateKey(startDate);
	const endDateKey = getDateKey(endDate);

	// SHL You are again throwing errors without logging and I'm unclear how these happen. I notice that here there is no identifier (fine probably) but in another place it does. Also, what is your plan on how to deal with all these errors - I don't see try/catch in the code. Finally, the test code would be more comprehensive if it tested error conditions.
	// Adam: Done — the error now identifies the Week Pattern, is logged before
	// being thrown and equal/reversed ranges are covered by tests. The error
	// propagates to the existing caller rather than being silently handled here.
	if (startDateKey >= endDateKey) {
		const errMsg =
			`Holiday replacement range for Week Pattern ${weekId} must have ` +
			`a start before its end: ` +
			`${startDate} to ${endDate}.`;
		log.error(errMsg);
		throw new Error(errMsg);
	}

	// The Week Pattern stores the optional Holiday Instance Group ID.
	const week = await Week.getById(weekId, conn);

	// SHL I would think if a single return with if/else if could avoid them being in multiple places.
	// Adam: Done — missing and empty groups now share one empty-result return.
	let members = [];

	if (week.holidayInstanceGroupId != null) {
		members = await HolidayGroupMember.getByGroupId(week.holidayInstanceGroupId, conn);
	}

	// SHL Does OED allow an empty members list if there is a holiday group? If so, that should probably be reconsidered.
	// Adam: An empty Holiday Rate Group is treated as having no holiday
	// replacements, so the normal weekly pattern continues unchanged.
	if (members.length === 0) {
		return new Map();
	}

	// Each member provides the saved holiday name and location together with
	// the Day Pattern that replaces the normal weekly pattern.
	// SHL Conform with OED formatting expectations. I won't mark more of these.
	// Adam: Done — the call and surrounding file have been reformatted consistently with OED.
	const years = getYearsInRange(startDateKey, endDateKey);

	// Reuse providers and their yearly results when multiple configured
	// holidays use the same location.
	const providersByLocation = new Map();
	const holidaysByLocationAndYear = new Map();

	// SHL Did you consider using a Set data structure that would automatically not allow duplicates? Same for holidaysByLocationAndYear.
	// Adam: A Map is intentional because every unique key must also store an
	// associated reusable value. A Set provides uniqueness but cannot map a location
	// to its provider or a location/year to its holiday records.
	// Keyed by YYYY-MM-DD so that next step can efficiently check whether an
	// RRule occurrence is a configured holiday.
	const replacements = new Map();

	for (const member of members) {
		const location = member.location;
		const holidayName = member.holiday_name;

		if (!location) {
			const errMsg = `Cannot resolve holiday "${holidayName}" because it has no location.`;
			log.error(errMsg);
			throw new Error(errMsg);
		}
		if (!providersByLocation.has(location)) {
			providersByLocation.set(location, createHolidayProvider(location));
		}

		const provider = providersByLocation.get(location);

		// Were you able to find out if the holiday server can do multiple years/holidays?
		for (const year of years) {
			const providerCacheKey = `${location}:${year}`;

			if (!holidaysByLocationAndYear.has(providerCacheKey)) {
				let providerHolidays;

				try {
					providerHolidays = provider.getHolidays(year, 'en');
				} catch (error) {
					const errMsg = `Unable to resolve holidays for ${location} in ${year}: ${error.message}`;
					log.error(errMsg, error);
					throw new Error(errMsg);
				}

				// SHL This seems unlikely to happen and is a very weak check for the data returned. Does the UI do any validation? If yes, then combine. If no, then everywhere should be consistent to use new way or none. I would need to see the return format to give thoughts on how to test.
				// Adam: I removed the array-only check because date-holidays defines the return
				// contract and the check did not validate the individual records. Provider
				// exceptions are still propagated, and each matched date is strictly validated.
				// Huss, would you prefer a full schema check instead?
				holidaysByLocationAndYear.set(providerCacheKey, providerHolidays);
			}

			const providerHolidays = holidaysByLocationAndYear.get(providerCacheKey);

			// Match the configured holiday name exactly. Substring matching
			// could also select related holidays, such as "Day after
			// Thanksgiving Day" for "Thanksgiving Day".
			// SHL I'm curious about this being plural. How do you get multiple matches for a give holiday in a given year?
			// Adam: Done — exact matching now uses find() because OED expects one provider
			// record for a holiday name, location and year.
			const match = providerHolidays.find(holiday => holiday.name === holidayName);

			// SHL If can easily do if/else to avoid continue I would. I see a several of these below so wonder how the logic could be done.
			// Adam: Done — positive conditions and if/else are used instead of unnecessary continue statements.
			if (match !== undefined) {
				// OED holiday exceptions apply to full calendar days, so
				// provider times (for example Halloween at 18:00) are ignored.
				const holidayDateMoment = moment.utc(
					String(match.date).slice(0, 10),
					'YYYY-MM-DD',
					true
				);

				if (!holidayDateMoment.isValid()) {
					const errMsg = `Holiday provider returned an invalid date for "${holidayName}": ${match.date}`;
					log.error(errMsg);
					throw new Error(errMsg);
				}

				const holidayDate = holidayDateMoment.format('YYYY-MM-DD');

				// SHL Here you do start/end but see my comment above.
				// Adam: The range is intentionally half-open: the start is included and the
				// end is excluded. This prevents adjacent Conversion Segments from processing
				// the same holiday twice.
				// Use a half-open date range: include the start date and
				// exclude the end date so adjacent segments do not overlap.
				if (holidayDate >= startDateKey && holidayDate < endDateKey) {
					if (replacements.has(holidayDate)) {
						log.warn(
							`Multiple holiday replacements resolved for ` +
							`${holidayDate}; using the first replacement.`
						);
					} else {
						replacements.set(holidayDate, {
							// SHL Curious why some are JSON key/value and some are not.
							// Adam: holidayName and location use object shorthand because their property
							// and variable names match. The other fields explicitly map database
							// snake_case names to camelCase result properties.
							dayPatternId: member.day_pattern_id,
							holidayName,
							holidayInstanceId: member.holiday_instance_id,
							location
						});
					}
				}
			}
		}
	}

	// The loops above process members first, so explicitly sort the final Map
	// by calendar date before returning it.
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
