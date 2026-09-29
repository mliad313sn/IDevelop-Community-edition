'use strict';

const { neutralize, csvCell } = require('../../src/utils/csvSafe');

describe('csvSafe — formula-injection neutralization', () => {
    test('neutralize prefixes a quote for formula-trigger leading chars', () => {
        expect(neutralize('=1+1')).toBe("'=1+1");
        expect(neutralize('+1')).toBe("'+1");
        expect(neutralize('-1')).toBe("'-1");
        expect(neutralize('@SUM(A1)')).toBe("'@SUM(A1)");
        expect(neutralize('\tcmd')).toBe("'\tcmd");
        expect(neutralize('\rcmd')).toBe("'\rcmd");
    });

    test('neutralize leaves safe values untouched', () => {
        expect(neutralize('Engineering')).toBe('Engineering');
        expect(neutralize('a=b')).toBe('a=b'); // '=' not leading
        expect(neutralize('123')).toBe('123');
    });

    test('neutralize handles null/undefined as empty string', () => {
        expect(neutralize(null)).toBe('');
        expect(neutralize(undefined)).toBe('');
    });

    test('csvCell neutralizes AND RFC-4180 quotes', () => {
        expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
        expect(csvCell('plain')).toBe('"plain"');
        expect(csvCell('has,comma')).toBe('"has,comma"');
        expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    });

    test('csvCell guards the classic command-injection payload', () => {
        // A leading '=' would be evaluated by Excel/Sheets on open.
        const payload = "=cmd|'/c calc'!A1";
        const cell = csvCell(payload);
        expect(cell.startsWith('"\'=')).toBe(true); // inert leading quote present
    });
});
