/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { expect } = require('chai');
const sinon = require('sinon');

const ConversionSegment = require('../../models/ConversionSegment');
const DaySegment = require('../../models/DaySegment');
const HolidayGroupMember = require('../../models/HolidayGroupMember');
const Week = require('../../models/Week');

const {
    filterHolidayOccurrences,
    createHolidayReplacementSegments,
    timeVaryingPathConversion
} = require('../../services/graph/timeVaryingPathConversion');

describe('timeVaryingPathConversion holiday exceptions', () => {
    function expectUnchangedPatternOutput(results) {
        expect(results).to.have.lengthOf(5);
        expect(results.map(segment => segment.slope)).to.deep.equal([
            1,
            2,
            2,
            2,
            3
        ]);
        expect(results.slice(1, 4).map(segment =>
            new Date(segment.start_time).toISOString().slice(0, 10)
        )).to.deep.equal([
            '2026-11-23',
            '2026-11-24',
            '2026-11-25'
        ]);
        results.slice(1).forEach((segment, index) => {
            expect(new Date(results[index].end_time).getTime()).to.equal(
                new Date(segment.start_time).getTime()
            );
        });
    }

    afterEach(() => {
        sinon.restore();
    });

    it('removes the normal occurrence on a configured holiday date', () => {
        const occurrences = [
            new Date('2026-11-25T00:00:00.000Z'),
            new Date('2026-11-26T00:00:00.000Z'),
            new Date('2026-11-27T00:00:00.000Z')
        ];

        const holidayReplacements = new Map([
            [
                '2026-11-26',
                {
                    dayPatternId: 12,
                    holidayName: 'Thanksgiving Day'
                }
            ]
        ]);

        const filteredOccurrences = filterHolidayOccurrences(
            occurrences,
            holidayReplacements
        );

        expect(
            filteredOccurrences.map(occurrence =>
                occurrence.toISOString().slice(0, 10)
            )
        ).to.deep.equal([
            '2026-11-25',
            '2026-11-27'
        ]);
    });

    it('retains all occurrences when there are no configured holidays', () => {
        const occurrences = [
            new Date('2026-11-25T00:00:00.000Z'),
            new Date('2026-11-26T00:00:00.000Z'),
            new Date('2026-11-27T00:00:00.000Z')
        ];

        const filteredOccurrences = filterHolidayOccurrences(
            occurrences,
            new Map()
        );

        expect(filteredOccurrences).to.deep.equal(occurrences);
    });

    it('removes every occurrence time on a configured holiday date', () => {
        const occurrences = [
            new Date('2026-11-26T00:00:00.000Z'),
            new Date('2026-11-26T08:00:00.000Z'),
            new Date('2026-11-26T18:00:00.000Z'),
            new Date('2026-11-27T00:00:00.000Z')
        ];

        const holidayReplacements = new Map([
            ['2026-11-26', { dayPatternId: 12, holidayName: 'Thanksgiving Day' }]
        ]);

        const filteredOccurrences = filterHolidayOccurrences(
            occurrences,
            holidayReplacements
        );

        expect(filteredOccurrences).to.have.lengthOf(1);
        expect(filteredOccurrences[0].toISOString()).to.equal(
            '2026-11-27T00:00:00.000Z'
        );
    });

    it('creates chronologically ordered segments for each holiday Day Segment', async () => {
        sinon.stub(DaySegment, 'getByDayId').resolves([
            { startHour: 0, endHour: 8, slope: 2, intercept: 3 },
            { startHour: 8, endHour: 18, slope: 5, intercept: 7 },
            { startHour: 18, endHour: 24, slope: 11, intercept: 13 }
        ]);

        const replacements = new Map([
            ['2026-11-26', { dayPatternId: 12, holidayName: 'Thanksgiving Day' }]
        ]);

        const segments = await createHolidayReplacementSegments(
            replacements,
            31,
            42,
            {}
        );

        expect(segments.map(segment => [
            segment.startTime,
            segment.endTime,
            segment.slope,
            segment.intercept
        ])).to.deep.equal([
            ['2026-11-26T00:00:00.000Z', '2026-11-26T08:00:00.000Z', 2, 3],
            ['2026-11-26T08:00:00.000Z', '2026-11-26T18:00:00.000Z', 5, 7],
            ['2026-11-26T18:00:00.000Z', '2026-11-27T00:00:00.000Z', 11, 13]
        ]);
        expect(segments.every(segment =>
            segment.sourceId === 31 && segment.destinationId === 42
        )).to.equal(true);
    });

    it('returns no segments and skips Day Segment lookup for an empty holiday Map', async () => {
        const getByDayIdStub = sinon.stub(DaySegment, 'getByDayId');

        const segments = await createHolidayReplacementSegments(
            new Map(),
            31,
            42,
            {}
        );

        expect(segments).to.deep.equal([]);
        expect(getByDayIdStub.called).to.equal(false);
    });

    it('creates replacement segments for every holiday date', async () => {
        const getByDayIdStub = sinon.stub(DaySegment, 'getByDayId')
            .callsFake(async dayPatternId => [{
                startHour: 0,
                endHour: 24,
                slope: dayPatternId,
                intercept: dayPatternId * 10
            }]);

        const replacements = new Map([
            ['2025-11-27', { dayPatternId: 12 }],
            ['2026-11-26', { dayPatternId: 15 }]
        ]);

        const segments = await createHolidayReplacementSegments(
            replacements,
            31,
            42,
            {}
        );

        expect(getByDayIdStub.getCalls().map(call => call.args[0])).to.deep.equal([
            12,
            15
        ]);
        expect(segments.map(segment => [
            segment.startTime,
            segment.endTime,
            segment.slope,
            segment.intercept
        ])).to.deep.equal([
            ['2025-11-27T00:00:00.000Z', '2025-11-28T00:00:00.000Z', 12, 120],
            ['2026-11-26T00:00:00.000Z', '2026-11-27T00:00:00.000Z', 15, 150]
        ]);
    });

    it('replaces normal holiday occurrences without gaps or overlaps', async () => {
        sinon.stub(DaySegment, 'getByDayId').resolves([
            { startHour: 0, endHour: 8, slope: 2, intercept: 3 },
            { startHour: 8, endHour: 18, slope: 5, intercept: 7 },
            { startHour: 18, endHour: 24, slope: 11, intercept: 13 }
        ]);

        const normalSegments = [
            { startTime: new Date('2026-11-25T00:00:00.000Z'), endTime: new Date('2026-11-26T00:00:00.000Z'), slope: 20 },
            { startTime: new Date('2026-11-26T00:00:00.000Z'), endTime: new Date('2026-11-27T00:00:00.000Z'), slope: 20 },
            { startTime: new Date('2026-11-27T00:00:00.000Z'), endTime: new Date('2026-11-28T00:00:00.000Z'), slope: 20 }
        ];
        const replacements = new Map([
            ['2026-11-26', { dayPatternId: 12 }]
        ]);
        const filteredDates = filterHolidayOccurrences(
            normalSegments.map(segment => segment.startTime),
            replacements
        );
        const retainedDates = new Set(filteredDates.map(date =>
            date.toISOString().slice(0, 10)
        ));
        const filteredNormalSegments = normalSegments.filter(segment =>
            retainedDates.has(segment.startTime.toISOString().slice(0, 10))
        );
        const holidaySegments = await createHolidayReplacementSegments(
            replacements,
            31,
            42,
            {}
        );
        const combinedSegments = [...filteredNormalSegments, ...holidaySegments]
            .sort((left, right) =>
                new Date(left.startTime) - new Date(right.startTime)
            );

        expect(combinedSegments.map(segment => new Date(segment.startTime).toISOString())).to.deep.equal([
            '2026-11-25T00:00:00.000Z',
            '2026-11-26T00:00:00.000Z',
            '2026-11-26T08:00:00.000Z',
            '2026-11-26T18:00:00.000Z',
            '2026-11-27T00:00:00.000Z'
        ]);
        expect(combinedSegments.some(segment =>
            new Date(segment.startTime).toISOString() === '2026-11-26T00:00:00.000Z' &&
            segment.slope === 20
        )).to.equal(false);
        expect(combinedSegments.slice(1, 4).map(segment => segment.slope)).to.deep.equal([
            2,
            5,
            11
        ]);
        combinedSegments.slice(1).forEach((segment, index) => {
            expect(new Date(combinedSegments[index].endTime).toISOString()).to.equal(
                new Date(segment.startTime).toISOString()
            );
        });
    });

    it('preserves patterned conversion output when there is no Holiday Group', async () => {
        sinon.stub(ConversionSegment, 'getBySourceDestination').resolves([
            {
                sourceId: 31,
                destinationId: 42,
                weekPatternsId: null,
                slope: 1,
                intercept: 0,
                startTime: '-infinity',
                endTime: '2026-11-23T00:00:00.000Z'
            },
            {
                sourceId: 31,
                destinationId: 42,
                weekPatternsId: 7,
                slope: 0,
                intercept: 0,
                startTime: '2026-11-23T00:00:00.000Z',
                endTime: '2026-11-26T00:00:00.000Z'
            },
            {
                sourceId: 31,
                destinationId: 42,
                weekPatternsId: null,
                slope: 3,
                intercept: 0,
                startTime: '2026-11-26T00:00:00.000Z',
                endTime: 'infinity'
            }
        ]);
        sinon.stub(Week, 'getById').resolves({
            sunday: 10,
            monday: 10,
            tuesday: 10,
            wednesday: 10,
            thursday: 10,
            friday: 10,
            saturday: 10,
            holidayInstanceGroupId: null
        });
        sinon.stub(DaySegment, 'getByDayId').resolves([
            { dayId: 10, startHour: 0, endHour: 24, slope: 2, intercept: 3 }
        ]);
        const getByGroupIdStub = sinon.stub(HolidayGroupMember, 'getByGroupId');

        const results = await timeVaryingPathConversion(
            [{ id: 31 }, { id: 42 }],
            {}
        );

        expectUnchangedPatternOutput(results);
        expect(getByGroupIdStub.called).to.equal(false);
    });

    it('preserves patterned conversion output when the Holiday Group is empty', async () => {
        sinon.stub(ConversionSegment, 'getBySourceDestination').resolves([
            {
                sourceId: 31,
                destinationId: 42,
                weekPatternsId: null,
                slope: 1,
                intercept: 0,
                startTime: '-infinity',
                endTime: '2026-11-23T00:00:00.000Z'
            },
            {
                sourceId: 31,
                destinationId: 42,
                weekPatternsId: 7,
                slope: 0,
                intercept: 0,
                startTime: '2026-11-23T00:00:00.000Z',
                endTime: '2026-11-26T00:00:00.000Z'
            },
            {
                sourceId: 31,
                destinationId: 42,
                weekPatternsId: null,
                slope: 3,
                intercept: 0,
                startTime: '2026-11-26T00:00:00.000Z',
                endTime: 'infinity'
            }
        ]);
        sinon.stub(Week, 'getById').resolves({
            sunday: 10,
            monday: 10,
            tuesday: 10,
            wednesday: 10,
            thursday: 10,
            friday: 10,
            saturday: 10,
            holidayInstanceGroupId: 5
        });
        sinon.stub(DaySegment, 'getByDayId').resolves([
            { dayId: 10, startHour: 0, endHour: 24, slope: 2, intercept: 3 }
        ]);
        const getByGroupIdStub = sinon.stub(
            HolidayGroupMember,
            'getByGroupId'
        ).resolves([]);

        const results = await timeVaryingPathConversion(
            [{ id: 31 }, { id: 42 }],
            {}
        );

        expectUnchangedPatternOutput(results);
        expect(getByGroupIdStub.calledOnce).to.equal(true);
    });
});
