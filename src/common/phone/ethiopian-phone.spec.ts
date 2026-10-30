import {
  ETHIOPIAN_MOBILE_E164,
  normaliseEthiopianMobile,
} from './ethiopian-phone.js';

// Same pattern as the users table's CHK_users_phone_e164 constraint.
const DB_E164 = /^\+[1-9][0-9]{7,14}$/;

describe('normaliseEthiopianMobile', () => {
  it.each([
    // Local forms
    ['0911234567', '+251911234567'],
    ['911234567', '+251911234567'],
    ['0711234567', '+251711234567'],
    ['711234567', '+251711234567'],
    // Country-code forms
    ['+251911234567', '+251911234567'],
    ['251911234567', '+251911234567'],
    ['+251711234567', '+251711234567'],
    ['251711234567', '+251711234567'],
    // International dialling prefix 00
    ['00251911234567', '+251911234567'],
    ['00251711234567', '+251711234567'],
    // Mistaken trunk 0 after the country code
    ['+2510911234567', '+251911234567'],
    ['2510911234567', '+251911234567'],
    ['+2510711234567', '+251711234567'],
    ['002510911234567', '+251911234567'],
    // Separators and surrounding whitespace
    ['0911 23 45 67', '+251911234567'],
    ['091-123-4567', '+251911234567'],
    ['(091) 123-4567', '+251911234567'],
    ['+251 91 123 4567', '+251911234567'],
    ['+251-911-234-567', '+251911234567'],
    ['0911.234.567', '+251911234567'],
    ['  0911234567\n', '+251911234567'],
    ['00 251 711 234 567', '+251711234567'],
  ])('normalises %j to %s', (input, expected) => {
    expect(normaliseEthiopianMobile(input)).toBe(expected);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['too short (local)', '091123456'],
    ['too long (local)', '09112345678'],
    ['too short (+251)', '+25191123456'],
    ['too long (+251)', '+2519112345678'],
    ['Addis landline', '0111234567'],
    ['landline with country code', '+251111234567'],
    ['other first digit', '0811234567'],
    ['two trunk zeros', '00911234567'],
    ['two trunk zeros after +251', '+25100911234567'],
    ['foreign number (UK)', '+447700900123'],
    ['foreign number (Kenya)', '+254712345678'],
    ['+ without 251', '+911234567'],
    ['two plus signs', '++251911234567'],
    ['plus in the middle', '0911+234567'],
    ['letters', '09112345ab'],
    ['words', 'call me'],
    ['Arabic-Indic digits', '٠٩١١٢٣٤٥٦٧'],
    ['full-width digits', '０９１１２３４５６７'],
    ['other punctuation', '0911/234/567'],
  ])('rejects %s (%j)', (_label, input) => {
    expect(normaliseEthiopianMobile(input)).toBeNull();
  });

  it.each(['0911234567', '0711234567', '+2510911234567', '00251711234567'])(
    'output for %j passes both the app and DB patterns',
    (input) => {
      const result = normaliseEthiopianMobile(input);

      expect(result).toMatch(ETHIOPIAN_MOBILE_E164);
      expect(result).toMatch(DB_E164);
    },
  );
});
