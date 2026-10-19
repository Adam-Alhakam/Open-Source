/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { expect } = require('chai');
const sinon = require('sinon');

const Week = require('../../models/Week');
const HolidayGroupMember = require('../../models/HolidayGroupMember');
const { log } = require('../../log');
const {
    getHolidayReplacements
} = require('../../services/graph/getHolidayReplacements');

describe('getHolidayReplacements', () => {
    // The model methods are stubbed, so the resolver does not use this
    // connection. Supplying an object still verifies that the function accepts
    // and forwards a database connection.
    const conn = {};

    afterEach(() => {
        // Restore all model and logger methods changed by the current test.
        sinon.restore();
    });

    it('returns an empty Map when the Week Pattern has no Holiday Instance Group', async () => {
        sinon.stub(Week, 'getById').resolves({
            holidayInstanceGroupId: null
        });

        const getByGroupIdStub = sinon.stub(
            HolidayGroupMember,
            'getByGroupId'
        );

        const replacements = await getHolidayReplacements(
            1,
            '2025-01-01',
            '2026-01-01',
            conn
        );

        expect(replacements).to.be.instanceOf(Map);
        expect(replacements.size).to.equal(0);
        expect(getByGroupIdStub.called).to.equal(false);
    });

    it('resolves Thanksgiving across multiple years', async () => {
        sinon.stub(Week, 'getById').resolves({
            holidayInstanceGroupId: 4
        });

        sinon.stub(
            HolidayGroupMember,
            'getByGroupId'
        ).resolves([
            {
                holiday_instance_id: 7,
                holiday_name: 'Thanksgiving Day',
                day_pattern_id: 12,
                location: 'US'
            }
        ]);

        const replacements = await getHolidayReplacements(
            1,
            '2025-01-01',
            '2027-01-01',
            conn
        );

        expect(Array.from(replacements.keys())).to.deep.equal([
            '2025-11-27',
            '2026-11-26'
        ]);

        expect(replacements.get('2025-11-27')).to.deep.equal({
            dayPatternId: 12,
            holidayName: 'Thanksgiving Day',
            holidayInstanceId: 7,
            location: 'US'
        });

        expect(replacements.get('2026-11-26')).to.deep.equal({
            dayPatternId: 12,
            holidayName: 'Thanksgiving Day',
            holidayInstanceId: 7,
            location: 'US'
        });
    });

    it('uses exact holiday-name matching', async () => {
        sinon.stub(Week, 'getById').resolves({
            holidayInstanceGroupId: 4
        });

        sinon.stub(
            HolidayGroupMember,
            'getByGroupId'
        ).resolves([
            {
                holiday_instance_id: 7,
                holiday_name: 'Thanksgiving Day',
                day_pattern_id: 12,
                location: 'US'
            }
        ]);

        const replacements = await getHolidayReplacements(
            1,
            '2025-11-01',
            '2025-12-01',
            conn
        );

        // date-holidays also contains "Day after Thanksgiving Day" on
        // 2025-11-28. Exact matching must return only Thanksgiving Day.
        expect(Array.from(replacements.keys())).to.deep.equal([
            '2025-11-27'
        ]);

        expect(replacements.has('2025-11-28')).to.equal(false);
    });

    it('includes a holiday that occurs on the range start date', async () => {
        sinon.stub(Week, 'getById').resolves({
            holidayInstanceGroupId: 4
        });

        sinon.stub(
            HolidayGroupMember,
            'getByGroupId'
        ).resolves([
            {
                holiday_instance_id: 7,
                holiday_name: 'Thanksgiving Day',
                day_pattern_id: 12,
                location: 'US'
            }
        ]);

        const replacements = await getHolidayReplacements(
            1,
            '2026-11-26',
            '2026-12-01',
            conn
        );

        expect(replacements.has('2026-11-26')).to.equal(true);
    });

    it('excludes a holiday that occurs on the range end date', async () => {
        sinon.stub(Week, 'getById').resolves({
            holidayInstanceGroupId: 4
        });

        sinon.stub(
            HolidayGroupMember,
            'getByGroupId'
        ).resolves([
            {
                holiday_instance_id: 7,
                holiday_name: 'Thanksgiving Day',
                day_pattern_id: 12,
                location: 'US'
            }
        ]);

        const replacements = await getHolidayReplacements(
            1,
            '2026-11-01',
            '2026-11-26',
            conn
        );

        expect(replacements.has('2026-11-26')).to.equal(false);
        expect(replacements.size).to.equal(0);
    });

    it('resolves a substitute holiday separately from its original holiday', async () => {
        sinon.stub(Week, 'getById').resolves({
            holidayInstanceGroupId: 4
        });

        sinon.stub(
            HolidayGroupMember,
            'getByGroupId'
        ).resolves([
            {
                holiday_instance_id: 9,
                holiday_name: 'Independence Day (substitute day)',
                day_pattern_id: 15,
                location: 'US'
            }
        ]);

        const replacements = await getHolidayReplacements(
            1,
            '2021-01-01',
            '2022-01-01',
            conn
        );

        expect(Array.from(replacements.keys())).to.deep.equal([
            '2021-07-05'
        ]);

        expect(replacements.has('2021-07-04')).to.equal(false);

        expect(replacements.get('2021-07-05')).to.deep.equal({
            dayPatternId: 15,
            holidayName: 'Independence Day (substitute day)',
            holidayInstanceId: 9,
            location: 'US'
        });
    });

    it('returns no occurrence when a substitute holiday does not occur in the requested year', async () => {
        sinon.stub(Week, 'getById').resolves({
            holidayInstanceGroupId: 4
        });

        sinon.stub(
            HolidayGroupMember,
            'getByGroupId'
        ).resolves([
            {
                holiday_instance_id: 9,
                holiday_name: 'Independence Day (substitute day)',
                day_pattern_id: 15,
                location: 'US'
            }
        ]);

        // July 4, 2024 was a Thursday, so the US provider does not return
        // an Independence Day substitute occurrence for this year.
        const replacements = await getHolidayReplacements(
            1,
            '2024-01-01',
            '2025-01-01',
            conn
        );

        expect(replacements.size).to.equal(0);
    });

    it('keeps one replacement when multiple Holiday Rates resolve to the same date', async () => {
        sinon.stub(Week, 'getById').resolves({
            holidayInstanceGroupId: 4
        });

        sinon.stub(
            HolidayGroupMember,
            'getByGroupId'
        ).resolves([
            {
                holiday_instance_id: 7,
                holiday_name: 'Thanksgiving Day',
                day_pattern_id: 12,
                location: 'US'
            },
            {
                holiday_instance_id: 8,
                holiday_name: 'Thanksgiving Day',
                day_pattern_id: 15,
                location: 'US'
            }
        ]);

        const warningStub = sinon.stub(log, 'warn');

        const replacements = await getHolidayReplacements(
            1,
            '2026-01-01',
            '2027-01-01',
            conn
        );

        expect(replacements.size).to.equal(1);
        expect(replacements.has('2026-11-26')).to.equal(true);

        // The implementation keeps the first replacement found.
        expect(
            replacements.get('2026-11-26').dayPatternId
        ).to.equal(12);

        expect(warningStub.calledOnce).to.equal(true);
    });

    it('returns replacements sorted by calendar date', async () => {
        sinon.stub(Week, 'getById').resolves({
            holidayInstanceGroupId: 4
        });

        // The members are intentionally placed in reverse calendar order.
        sinon.stub(
            HolidayGroupMember,
            'getByGroupId'
        ).resolves([
            {
                holiday_instance_id: 11,
                holiday_name: 'Christmas Day',
                day_pattern_id: 16,
                location: 'US'
            },
            {
                holiday_instance_id: 7,
                holiday_name: 'Thanksgiving Day',
                day_pattern_id: 12,
                location: 'US'
            }
        ]);

        const replacements = await getHolidayReplacements(
            1,
            '2026-01-01',
            '2027-01-01',
            conn
        );

        expect(Array.from(replacements.keys())).to.deep.equal([
            '2026-11-26',
            '2026-12-25'
        ]);
    });

    it('rejects and logs a range whose start is equal to its end', async () => {
        const errorLogStub = sinon.stub(log, 'error');
        let error;

        try {
            await getHolidayReplacements(
                1,
                '2026-01-01',
                '2026-01-01',
                conn
            );
        } catch (caughtError) {
            error = caughtError;
        }

        expect(error).to.be.instanceOf(Error);
        expect(error.message).to.include(
            'Holiday replacement range for Week Pattern 1 must have a start before its end'
        );
        expect(errorLogStub.calledOnceWithExactly(error.message)).to.equal(true);
    });


    it('rejects and logs a range whose start is after its end', async () => {
        const errorLogStub = sinon.stub(log, 'error');
        let error;

        try {
            await getHolidayReplacements(
                1,
                '2027-01-01',
                '2026-01-01',
                conn
            );
        } catch (caughtError) {
            error = caughtError;
        }

        expect(error).to.be.instanceOf(Error);
        expect(error.message).to.include(
            'Holiday replacement range for Week Pattern 1 must have a start before its end'
        );
        expect(errorLogStub.calledOnceWithExactly(error.message)).to.equal(true);
    });

    it('passes the Week Holiday Group ID and connection to the model', async () => {
        sinon.stub(Week, 'getById').resolves({
            holidayInstanceGroupId: 42
        });

        const getByGroupIdStub = sinon.stub(
            HolidayGroupMember,
            'getByGroupId'
        ).resolves([]);

        await getHolidayReplacements(
            1,
            '2026-01-01',
            '2027-01-01',
            conn
        );

        expect(
            getByGroupIdStub.calledOnceWithExactly(42, conn)
        ).to.equal(true);
    });

    it('resolves multiple holidays across multiple years in one lookup', async () => {
        sinon.stub(Week, 'getById').resolves({
            holidayInstanceGroupId: 4
        });

        sinon.stub(
            HolidayGroupMember,
            'getByGroupId'
        ).resolves([
            {
                holiday_instance_id: 7,
                holiday_name: 'Thanksgiving Day',
                day_pattern_id: 12,
                location: 'US'
            },
            {
                holiday_instance_id: 11,
                holiday_name: 'Christmas Day',
                day_pattern_id: 16,
                location: 'US'
            }
        ]);

        const replacements = await getHolidayReplacements(
            1,
            '2025-01-01',
            '2027-01-01',
            conn
        );

        expect(Array.from(replacements.keys())).to.deep.equal([
            '2025-11-27',
            '2025-12-25',
            '2026-11-26',
            '2026-12-25'
        ]);

        expect(
            replacements.get('2025-11-27').dayPatternId
        ).to.equal(12);

        expect(
            replacements.get('2025-12-25').dayPatternId
        ).to.equal(16);

        expect(
            replacements.get('2026-11-26').dayPatternId
        ).to.equal(12);

        expect(
            replacements.get('2026-12-25').dayPatternId
        ).to.equal(16);
    });
});