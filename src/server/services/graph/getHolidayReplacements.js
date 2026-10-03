/* This Source Code Form is subject to the terms of the Mozilla Public
* License, v. 2.0. If a copy of the MPL was not distributed with this
* file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const DateHolidays = require('date-holidays');
const Week = require('../../models/Week');
const HolidayGroupMember = require('../../models/HolidayGroupMember');
const { getRruleDate } = require('./generateRrule');
const { log } = require('../../log');

const Holidays = DateHolidays.default || DateHolidays;

/**
 * Creates a date-holidays provider from an OED location.
 *
 * OED stores holiday locations in one of these forms:
 * US
 * US-CA
 * US-CA-LA
 *
 * @param {string} location The holiday location stored by OED.
 * @returns {Holidays} A configured date-holidays provider.
 */
function createHolidayProvider(location) {
    const locationParts = String(location).split('-');
    const country = locationParts[0];
    const state = locationParts[1];
    const region = locationParts[2];

    if (!country) {
            throw new Error('Cannot resolve a holiday without a location.');
    }

    if (region) {
            return new Holidays(country, state, region);
    }

    if (state) {
            return new Holidays(country, state);
    }

    return new Holidays(country);
}

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
    const startYear = Number(startDateKey.slice(0, 4));
    const endYear = Number(endDateKey.slice(0, 4));
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
 * @param {string} boundaryName Name used in an error message.
 * @returns {string} The normalized date in YYYY-MM-DD format.
 */
function getDateKey(value, boundaryName) {
    const date = getRruleDate(value);

    if (Number.isNaN(date.getTime())) {
            throw new Error(
                    `Invalid ${boundaryName} date for holiday replacement lookup: ${value}`
            );
    }

    return date.toISOString().slice(0, 10);
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
async function getHolidayReplacements(
    weekId,
    startDate,
    endDate,
    conn
) {
    const startDateKey = getDateKey(startDate, 'start');
    const endDateKey = getDateKey(endDate, 'end');

    if (startDateKey >= endDateKey) {
            throw new Error(
                    `Holiday replacement range must have start before end: ` +
                    `${startDate} to ${endDate}.`
            );
    }

    // The Week Pattern stores the optional Holiday Instance Group ID.
    const week = await Week.getById(weekId, conn);

    // A Week Pattern without a Holiday Instance Group continues to use its
    // normal weekly pattern without holiday replacements.
    if (week.holidayInstanceGroupId == null) {
            return new Map();
    }

    // Each member provides the saved holiday name and location together with
    // the Day Pattern that replaces the normal weekly pattern.
    const members = await HolidayGroupMember.getByGroupId(
            week.holidayInstanceGroupId,
            conn
    );

    if (members.length === 0) {
            return new Map();
    }

    const years = getYearsInRange(startDateKey, endDateKey);

    // Reuse providers and their yearly results when multiple configured
    // holidays use the same location.
    const providersByLocation = new Map();
    const holidaysByLocationAndYear = new Map();

    // Keyed by YYYY-MM-DD so that next step can efficiently check whether an
    // RRule occurrence is a configured holiday.
    const replacements = new Map();

    for (const member of members) {
            const location = member.location;
            const holidayName = member.holiday_name;

            if (!location) {
                    throw new Error(
                            `Cannot resolve holiday "${holidayName}" because it has no location.`
                    );
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
                                    throw new Error(
                                            `Unable to resolve holidays for ${location} in ${year}: ` +
                                            error.message
                                    );
                            }

                            if (!Array.isArray(providerHolidays)) {
                                    throw new Error(
                                            `Holiday provider returned invalid data for ` +
                                            `${location} in ${year}.`
                                    );
                            }

                            holidaysByLocationAndYear.set(
                                    providerCacheKey,
                                    providerHolidays
                            );
                    }

                    const providerHolidays = holidaysByLocationAndYear.get(
                            providerCacheKey
                    );

                    // Use exact matching. Substring matching is unsafe because names
                    // such as "Thanksgiving Day" and "Day after Thanksgiving Day"
                    // would both match "Thanksgiving".
                    const matches = providerHolidays.filter(
                            holiday => holiday.name === holidayName
                    );

                    // Some provider holidays, particularly substitute holidays, do
                    // not occur every year. A successful provider response with no
                    // exact match means there is no occurrence for that year.
                    if (matches.length === 0) {
                            continue;
                    }

                    for (const match of matches) {
                            // OED holiday exceptions are full calendar days. Provider
                            // times, such as Halloween beginning at 18:00, are not used.
                            const holidayDate = String(match.date).slice(0, 10);

                            if (!/^\d{4}-\d{2}-\d{2}$/.test(holidayDate)) {
                                    throw new Error(
                                            `Holiday provider returned an invalid date for ` +
                                            `"${holidayName}": ${match.date}`
                                    );
                            }

                        
                            if (
                                    holidayDate < startDateKey ||
                                    holidayDate >= endDateKey
                            ) {
                                    continue;
                            }

                            
                            if (replacements.has(holidayDate)) {
                                    log.warn(
                                            `Multiple holiday replacements resolved for ` +
                                            `${holidayDate}; using the first replacement.`
                                    );
                                    continue;
                            }

                            replacements.set(holidayDate, {
                                    dayPatternId: member.day_pattern_id,
                                    holidayName,
                                    holidayInstanceId: member.holiday_instance_id,
                                    location
                            });
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