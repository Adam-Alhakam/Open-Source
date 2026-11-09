/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { mocha, expect, testDB } = require('../common');

const Day = require('../../models/Day');
const Week = require('../../models/Week');
const { generateRrule } = require('../../services/graph/generateRrule');

mocha.describe('generateRrule database integration', () => {
    mocha.it('loads a Week Pattern and Day Segment from the database', async () => {
        const conn = testDB.getConnection();

        // Day.insert() creates the Day Pattern and one default Day Segment
        // covering hour 0 through hour 24.
        const day = new Day(
            undefined,
            'RRule integration day',
            'Day Pattern for the generateRrule database test'
        );

        await day.insert(
            2,
            3,
            'Default 0-24 Day Segment',
            conn
        );

        expect(day.id).to.be.a('number');

        // Use the inserted Day Pattern for every weekday.
        const weekName = 'RRule integration week';

        const week = new Week(
            undefined,
            weekName,
            'Week Pattern for the generateRrule database test',
            day.id,
            day.id,
            day.id,
            day.id,
            day.id,
            day.id,
            day.id,
            null
        );

        await week.insert(conn);

        // Week.insert() does not assign the generated ID to week.id, so load
        // the saved Week Pattern and locate it by its unique test name.
        const savedWeeks = await Week.getAll(conn);
        const savedWeek = savedWeeks.find(
            currentWeek => currentWeek.name === weekName
        );

        expect(savedWeek).to.not.equal(undefined);
        expect(savedWeek.sunday).to.equal(day.id);
        expect(savedWeek.monday).to.equal(day.id);
        expect(savedWeek.saturday).to.equal(day.id);

        // generateRrule() now uses the real Week and Day Segment model methods.
        const ruleInfo = await generateRrule(
            savedWeek.id,
            '2026-11-23 00:00:00',
            '2026-11-26 00:00:00',
            conn
        );

        expect(ruleInfo).to.have.lengthOf(1);
        expect(ruleInfo[0].duration).to.equal(24);
        expect(ruleInfo[0].slope).to.equal(2);
        expect(ruleInfo[0].intercept).to.equal(3);

        const occurrences = ruleInfo[0].rule.between(
            new Date('2026-11-23 00:00:00'),
            new Date('2026-11-26 00:00:00'),
            true
        );

        expect(occurrences).to.have.lengthOf(3);

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
