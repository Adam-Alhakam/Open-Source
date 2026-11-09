/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { expect } = require('chai');
const sinon = require('sinon');

const Week = require('../../models/Week');
const DaySegment = require('../../models/DaySegment');
const { generateRrule } = require('../../services/graph/generateRrule');

describe('generateRrule', () => {
    afterEach(() => {
        sinon.restore();
    });

    it('returns weekday occurrences from Monday through Friday', async () => {
        sinon.stub(Week, 'getById').resolves({
            sunday: 20,
            monday: 10,
            tuesday: 10,
            wednesday: 10,
            thursday: 10,
            friday: 10,
            saturday: 20
        });
        sinon.stub(DaySegment, 'getByDayId').callsFake(async dayId => [{
            dayId,
            startHour: 0,
            endHour: 24,
            slope: dayId === 10 ? 2 : 4,
            intercept: 3
        }]);
        const conn = {};

        const ruleInfo = await generateRrule(
            1,
            '2026-11-23 00:00:00',
            '2026-11-28 00:00:00',
            conn
        );

        const weekdayRule = ruleInfo.find(info => info.slope === 2);
        expect(weekdayRule.duration).to.equal(24);
        expect(weekdayRule.intercept).to.equal(3);

        const occurrences = weekdayRule.rule.between(
            new Date('2026-11-23 00:00:00'),
            new Date('2026-11-28 00:00:00'),
            true
        );

        expect(occurrences).to.have.lengthOf(5);

        const occurrenceDates = occurrences.map(occurrence =>
            occurrence.toISOString().slice(0, 10)
        );

        expect(occurrenceDates).to.deep.equal([
            '2026-11-23',
            '2026-11-24',
            '2026-11-25',
            '2026-11-26',
            '2026-11-27'
        ]);
    });

    it('returns weekend occurrences on Saturday and Sunday', async () => {
        sinon.stub(Week, 'getById').resolves({
            sunday: 20,
            monday: 10,
            tuesday: 10,
            wednesday: 10,
            thursday: 10,
            friday: 10,
            saturday: 20
        });
        sinon.stub(DaySegment, 'getByDayId').callsFake(async dayId => [{
            dayId,
            startHour: 0,
            endHour: 24,
            slope: dayId === 20 ? 4 : 2,
            intercept: 3
        }]);

        const ruleInfo = await generateRrule(
            1,
            '2026-11-21 00:00:00',
            '2026-11-23 00:00:00',
            {}
        );

        const weekendRule = ruleInfo.find(info => info.slope === 4);
        const occurrences = weekendRule.rule.between(
            new Date('2026-11-21 00:00:00'),
            new Date('2026-11-23 00:00:00'),
            true
        );
        const occurrenceDates = occurrences.map(occurrence =>
            occurrence.toISOString().slice(0, 10)
        );

        expect(occurrenceDates).to.deep.equal([
            '2026-11-21',
            '2026-11-22'
        ]);
    });

    it('excludes the end date', async () => {
        sinon.stub(Week, 'getById').resolves({
            sunday: 10,
            monday: 10,
            tuesday: 10,
            wednesday: 10,
            thursday: 10,
            friday: 10,
            saturday: 10
        });
        sinon.stub(DaySegment, 'getByDayId').resolves([{
            dayId: 10,
            startHour: 0,
            endHour: 24,
            slope: 2,
            intercept: 3
        }]);

        const ruleInfo = await generateRrule(
            1,
            '2026-11-23 00:00:00',
            '2026-11-26 00:00:00',
            {}
        );
        const occurrences = ruleInfo[0].rule.between(
            new Date('2026-11-23 00:00:00'),
            new Date('2026-11-26 00:00:00'),
            true
        );
        const occurrenceDates = occurrences.map(occurrence =>
            occurrence.toISOString().slice(0, 10)
        );

        expect(occurrenceDates).to.deep.equal([
            '2026-11-23',
            '2026-11-24',
            '2026-11-25'
        ]);
    });
});
