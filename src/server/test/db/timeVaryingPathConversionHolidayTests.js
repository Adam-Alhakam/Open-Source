/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { mocha, expect, testDB } = require('../common');

const Conversion = require('../../models/Conversion');
const ConversionSegment = require('../../models/ConversionSegment');
const Day = require('../../models/Day');
const DaySegment = require('../../models/DaySegment');
const Holiday = require('../../models/Holiday');
const HolidayGroupMember = require('../../models/HolidayGroupMember');
const HolidayInstance = require('../../models/HolidayInstance');
const HolidayInstanceGroup = require('../../models/HolidayInstanceGroup');
const Unit = require('../../models/Unit');
const Week = require('../../models/Week');
const {
    timeVaryingPathConversion
} = require('../../services/graph/timeVaryingPathConversion');

async function insertDayPattern(name, segments, conn) {
    const day = new Day(undefined, name, `${name} integration pattern`);
    const firstSegment = segments[0];
    await day.insert(
        firstSegment.slope,
        firstSegment.intercept,
        firstSegment.note,
        conn
    );

    let daySegments = await DaySegment.getByDayId(day.id, conn);
    for (const segment of segments.slice(1)) {
        const segmentToSplit = daySegments.find(
            currentSegment => currentSegment.startHour < segment.startHour &&
                currentSegment.endHour > segment.startHour
        );
        await DaySegment.splitLater(
            segmentToSplit.id,
            segment.slope,
            segment.intercept,
            segment.note,
            segment.startHour,
            conn
        );
        daySegments = await DaySegment.getByDayId(day.id, conn);
    }

    return day;
}

async function createMultiHolidayFixture(conn, withHolidayGroup) {
    const source = new Unit(
        undefined,
        'Multi-holiday integration source',
        'Multi-holiday integration source',
        Unit.unitRepresentType.QUANTITY,
        3600,
        Unit.unitType.METER,
        '',
        Unit.displayableType.ADMIN,
        true,
        'Multi-holiday integration source unit'
    );
    const destination = new Unit(
        undefined,
        'Multi-holiday integration destination',
        'Multi-holiday integration destination',
        Unit.unitRepresentType.QUANTITY,
        3600,
        Unit.unitType.UNIT,
        '',
        Unit.displayableType.ADMIN,
        true,
        'Multi-holiday integration destination unit'
    );
    await source.insert(conn);
    await destination.insert(conn);

    const weekday = await insertDayPattern('Multi-holiday weekday', [
        { startHour: 0, endHour: 8, slope: 1, intercept: 0, note: '00-08' },
        { startHour: 8, endHour: 18, slope: 2, intercept: 0, note: '08-18' },
        { startHour: 18, endHour: 24, slope: 3, intercept: 0, note: '18-24' }
    ], conn);
    const weekend = await insertDayPattern('Multi-holiday weekend', [
        { startHour: 0, endHour: 24, slope: 4, intercept: 0, note: '00-24' }
    ], conn);
    const thanksgiving = await insertDayPattern('Thanksgiving replacement', [
        { startHour: 0, endHour: 12, slope: 10, intercept: 0, note: '00-12' },
        { startHour: 12, endHour: 24, slope: 11, intercept: 0, note: '12-24' }
    ], conn);
    const christmas = await insertDayPattern('Christmas replacement', [
        { startHour: 0, endHour: 6, slope: 20, intercept: 0, note: '00-06' },
        { startHour: 6, endHour: 20, slope: 21, intercept: 0, note: '06-20' },
        { startHour: 20, endHour: 24, slope: 22, intercept: 0, note: '20-24' }
    ], conn);

    const holidayGroup = new HolidayInstanceGroup(
        undefined,
        'Multi-holiday integration group',
        'Thanksgiving and Christmas'
    );
    await holidayGroup.insert(conn);

    const holidayRates = [
        {
            name: 'Thanksgiving Day',
            date: '2026-11-26',
            day: thanksgiving
        },
        {
            name: 'Christmas Day',
            date: '2026-12-25',
            day: christmas
        }
    ];

    for (const [index, rate] of holidayRates.entries()) {
        const holiday = new Holiday(
            undefined,
            rate.name,
            rate.date,
            'US',
            `${rate.name} integration holiday`
        );
        await holiday.insert(conn);

        const instance = new HolidayInstance(
            undefined,
            `Multi-holiday integration rate ${index + 1}`,
            holiday.id,
            rate.day.id,
            `${rate.name} replacement rate`
        );
        await instance.insert(conn);
        await new HolidayGroupMember(
            holidayGroup.id,
            instance.id
        ).insert(conn);
    }

    const week = new Week(
        undefined,
        `Multi-holiday integration week ${withHolidayGroup ? 'with' : 'without'} group`,
        'Weekday and weekend patterns with optional holiday replacements',
        weekend.id,
        weekday.id,
        weekday.id,
        weekday.id,
        weekday.id,
        weekday.id,
        weekend.id,
        withHolidayGroup ? holidayGroup.id : null
    );
    await week.insert(conn);
    const savedWeek = (await Week.getAll(conn)).find(
        currentWeek => currentWeek.name === week.name
    );

    const rangeStart = '2026-11-23 00:00:00';
    const rangeEnd = '2026-12-27 00:00:00';
    await new Conversion(
        source.id,
        destination.id,
        false,
        'Multi-holiday integration conversion'
    ).insert(null, 1, 0, 'Initial conversion', conn);
    await ConversionSegment.splitLater(
        source.id,
        destination.id,
        savedWeek.id,
        1,
        0,
        'Patterned conversion',
        '-infinity',
        'infinity',
        rangeStart,
        conn
    );
    await ConversionSegment.splitLater(
        source.id,
        destination.id,
        null,
        1,
        0,
        'After patterned conversion',
        rangeStart,
        'infinity',
        rangeEnd,
        conn
    );

    return {
        source,
        destination,
        rangeStart: new Date(`${rangeStart.slice(0, 10)}T00:00:00.000Z`),
        rangeEnd: new Date(`${rangeEnd.slice(0, 10)}T00:00:00.000Z`)
    };
}

function expectedSegmentsByDate(rangeStart, rangeEnd, includeHolidayPatterns) {
    const expected = new Map();
    const currentDate = new Date(rangeStart);

    while (currentDate < rangeEnd) {
        const dateKey = currentDate.toISOString().slice(0, 10);
        let dayPattern;

        if (includeHolidayPatterns && dateKey === '2026-11-26') {
            dayPattern = [[0, 12, 10], [12, 24, 11]];
        } else if (includeHolidayPatterns && dateKey === '2026-12-25') {
            dayPattern = [[0, 6, 20], [6, 20, 21], [20, 24, 22]];
        } else if ([0, 6].includes(currentDate.getUTCDay())) {
            dayPattern = [[0, 24, 4]];
        } else {
            dayPattern = [[0, 8, 1], [8, 18, 2], [18, 24, 3]];
        }

        expected.set(dateKey, dayPattern.map(([startHour, endHour, slope]) => {
            const startTime = new Date(`${dateKey}T00:00:00.000Z`);
            startTime.setUTCHours(startHour);
            const endTime = new Date(`${dateKey}T00:00:00.000Z`);
            endTime.setUTCHours(endHour);
            return [startTime.toISOString(), endTime.toISOString(), slope, 0];
        }));

        currentDate.setUTCDate(currentDate.getUTCDate() + 1);
    }

    return expected;
}

async function expectMultiHolidayScenario(withHolidayGroup) {
    const conn = testDB.getConnection();
    const fixture = await createMultiHolidayFixture(conn, withHolidayGroup);
    const allSegments = await timeVaryingPathConversion(
        [{ id: fixture.source.id }, { id: fixture.destination.id }],
        conn
    );
    const segments = allSegments.filter(segment =>
        segment.start_time >= fixture.rangeStart &&
        segment.end_time <= fixture.rangeEnd
    );

    expect(segments[0].start_time.toISOString()).to.equal(
        fixture.rangeStart.toISOString()
    );
    expect(segments[segments.length - 1].end_time.toISOString()).to.equal(
        fixture.rangeEnd.toISOString()
    );

    segments.forEach((segment, index) => {
        if (index > 0) {
            expect(segment.start_time.getTime()).to.be.at.least(
                segments[index - 1].start_time.getTime()
            );
            expect(segments[index - 1].end_time.getTime()).to.equal(
                segment.start_time.getTime()
            );
        }
    });

    const actualByDate = new Map();
    for (const segment of segments) {
        const dateKey = segment.start_time.toISOString().slice(0, 10);
        const dateSegments = actualByDate.get(dateKey) || [];
        dateSegments.push([
            segment.start_time.toISOString(),
            segment.end_time.toISOString(),
            segment.slope,
            segment.intercept
        ]);
        actualByDate.set(dateKey, dateSegments);
    }

    const expectedByDate = expectedSegmentsByDate(
        fixture.rangeStart,
        fixture.rangeEnd,
        withHolidayGroup
    );
    expect(Array.from(actualByDate.keys())).to.deep.equal(
        Array.from(expectedByDate.keys())
    );
    for (const [dateKey, expectedSegments] of expectedByDate) {
        expect(actualByDate.get(dateKey), `segments on ${dateKey}`).to.deep.equal(
            expectedSegments
        );
    }
    expect(segments).to.have.lengthOf(
        Array.from(expectedByDate.values()).reduce(
            (total, daySegments) => total + daySegments.length,
            0
        )
    );
}

mocha.describe('timeVaryingPathConversion holiday database integration', () => {
    mocha.it('replaces Thanksgiving with all holiday Day Segments', async () => {
        const conn = testDB.getConnection();
        const source = new Unit(
            undefined,
            'Holiday integration source',
            'Holiday integration source',
            Unit.unitRepresentType.QUANTITY,
            3600,
            Unit.unitType.METER,
            '',
            Unit.displayableType.ADMIN,
            true,
            'Holiday integration source unit'
        );
        const destination = new Unit(
            undefined,
            'Holiday integration destination',
            'Holiday integration destination',
            Unit.unitRepresentType.QUANTITY,
            3600,
            Unit.unitType.UNIT,
            '',
            Unit.displayableType.ADMIN,
            true,
            'Holiday integration destination unit'
        );
        await source.insert(conn);
        await destination.insert(conn);

        const normalDay = new Day(
            undefined,
            'Holiday integration normal day',
            'Normal weekday pattern'
        );
        await normalDay.insert(2, 3, 'Normal segment', conn);

        const holidayDay = new Day(
            undefined,
            'Holiday integration Thanksgiving day',
            'Thanksgiving replacement pattern'
        );
        await holidayDay.insert(2, 3, 'Midnight to 08:00', conn);
        let holidayDaySegments = await DaySegment.getByDayId(holidayDay.id, conn);
        await DaySegment.splitLater(
            holidayDaySegments[0].id,
            5,
            7,
            '08:00 to 18:00',
            8,
            conn
        );
        holidayDaySegments = await DaySegment.getByDayId(holidayDay.id, conn);
        const eightToTwentyFour = holidayDaySegments.find(
            segment => segment.startHour === 8
        );
        await DaySegment.splitLater(
            eightToTwentyFour.id,
            11,
            13,
            '18:00 to 24:00',
            18,
            conn
        );

        const holidayGroup = new HolidayInstanceGroup(
            undefined,
            'Thanksgiving integration group',
            'Holiday integration group'
        );
        await holidayGroup.insert(conn);

        const holiday = new Holiday(
            undefined,
            'Thanksgiving Day',
            '2026-11-26',
            'US',
            'Thanksgiving integration holiday'
        );
        await holiday.insert(conn);

        const holidayInstance = new HolidayInstance(
            undefined,
            'Thanksgiving integration rate',
            holiday.id,
            holidayDay.id,
            'Thanksgiving replacement rate'
        );
        await holidayInstance.insert(conn);
        await new HolidayGroupMember(
            holidayGroup.id,
            holidayInstance.id
        ).insert(conn);

        const week = new Week(
            undefined,
            'Thanksgiving integration week',
            'Week using normal day patterns and Thanksgiving replacement',
            normalDay.id,
            normalDay.id,
            normalDay.id,
            normalDay.id,
            normalDay.id,
            normalDay.id,
            normalDay.id,
            holidayGroup.id
        );
        await week.insert(conn);
        const savedWeek = (await Week.getAll(conn)).find(
            currentWeek => currentWeek.name === week.name
        );

        await new Conversion(
            source.id,
            destination.id,
            false,
            'Thanksgiving integration conversion'
        ).insert(null, 1, 0, 'Before patterned segment', conn);
        await ConversionSegment.splitLater(
            source.id,
            destination.id,
            savedWeek.id,
            0,
            0,
            'Patterned conversion segment',
            '-infinity',
            'infinity',
            '2026-11-25 00:00:00',
            conn
        );
        await ConversionSegment.splitLater(
            source.id,
            destination.id,
            null,
            3,
            0,
            'After patterned segment',
            '2026-11-25 00:00:00',
            'infinity',
            '2026-11-28 00:00:00',
            conn
        );

        const segments = await timeVaryingPathConversion(
            [{ id: source.id }, { id: destination.id }],
            conn
        );
        const normalizedSegments = segments.map(segment => ({
            startTime: segment.start_time === '-infinity'
                ? '-infinity'
                : new Date(segment.start_time).toISOString(),
            endTime: segment.end_time === 'infinity'
                ? 'infinity'
                : new Date(segment.end_time).toISOString(),
            slope: segment.slope,
            intercept: segment.intercept
        }));

        expect(normalizedSegments).to.deep.equal([
            {
                startTime: '-infinity',
                endTime: '2026-11-25T00:00:00.000Z',
                slope: 1,
                intercept: 0
            },
            {
                startTime: '2026-11-25T00:00:00.000Z',
                endTime: '2026-11-26T00:00:00.000Z',
                slope: 2,
                intercept: 3
            },
            {
                startTime: '2026-11-26T00:00:00.000Z',
                endTime: '2026-11-26T08:00:00.000Z',
                slope: 2,
                intercept: 3
            },
            {
                startTime: '2026-11-26T08:00:00.000Z',
                endTime: '2026-11-26T18:00:00.000Z',
                slope: 5,
                intercept: 7
            },
            {
                startTime: '2026-11-26T18:00:00.000Z',
                endTime: '2026-11-27T00:00:00.000Z',
                slope: 11,
                intercept: 13
            },
            {
                startTime: '2026-11-27T00:00:00.000Z',
                endTime: '2026-11-28T00:00:00.000Z',
                slope: 2,
                intercept: 3
            },
            {
                startTime: '2026-11-28T00:00:00.000Z',
                endTime: 'infinity',
                slope: 3,
                intercept: 0
            }
        ]);

        normalizedSegments.slice(2, 6).slice(1).forEach((segment, index) => {
            expect(normalizedSegments[index + 2].endTime).to.equal(
                segment.startTime
            );
        });
    });

    mocha.it('replaces multiple holidays across weekdays and resumes weekends', async () => {
        await expectMultiHolidayScenario(true);
    });

    mocha.it('keeps holiday dates on their normal Week Pattern without a group', async () => {
        await expectMultiHolidayScenario(false);
    });
});
