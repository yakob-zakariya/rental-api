import { ageOn, inspectDecision, mask } from './inspect-decision.lib.js';

const FIN = '123456789012';
const FAN = '1234567890123456';
const NAME = 'Abebe Kebede';
const AMHARIC_NAME = 'አበበ ከበደ';
const DOB = '1990-05-17';
const SECRETS = [
  FIN,
  FAN,
  NAME,
  'Abebe',
  'Kebede',
  AMHARIC_NAME,
  DOB,
  '1990',
  '2031-01-15',
  '2021-01-15',
  'https://',
  'cdn.didit',
  '196.188.1.2',
  'Bole',
  'Addis',
  'P<ETH',
  'Expired on',
  'secret-extra',
  'ET98765',
];

const decision = {
  session_id: 'c0ffee00-0000-4000-8000-000000000001',
  status: 'Approved',
  vendor_data: 'user-1',
  id_verifications: [
    {
      status: 'Approved',
      document_type: 'Identity Card',
      document_subtype: 'ID_CARD_GENERIC',
      issuing_state: 'ETH',
      issuing_state_name: 'Ethiopia',
      document_number: FIN,
      personal_number: FAN,
      date_of_birth: DOB,
      age: 36,
      expiration_date: '2031-01-15',
      date_of_issue: '2021-01-15',
      first_name: 'Abebe',
      last_name: 'Kebede',
      full_name: NAME,
      address: 'Bole, Addis Ababa',
      place_of_birth: 'Addis Ababa',
      verification_method: 'OCR',
      mrz: { raw: 'P<ETH' },
      portrait_image: 'https://cdn.didit.example/portrait.jpg',
      front_image: 'https://cdn.didit.example/front.jpg',
      extracted_data: { fin: FIN, holder: { name: NAME } },
      extra_fields: {
        native_name: AMHARIC_NAME,
        fan: 'ET98765',
        nested: { note: 'secret-extra', count: 3 },
      },
      warnings: [
        {
          risk: 'DOCUMENT_EXPIRED',
          feature: 'ID_VERIFICATION',
          log_type: 'warning',
          short_description: 'Expired on 2031-01-15',
          long_description: `Document of ${NAME} (${FIN}) expired`,
          additional_data: { number: FIN },
        },
      ],
    },
  ],
  liveness_checks: [
    {
      status: 'Approved',
      method: 'PASSIVE',
      score: 98.5,
      reference_image: 'https://cdn.didit.example/selfie.jpg',
      video_url: 'https://cdn.didit.example/v.mp4',
      warnings: [],
    },
  ],
  face_matches: [
    {
      status: 'Approved',
      score: 91.2,
      source_image: 'https://cdn.didit.example/a.jpg',
      target_image: 'https://cdn.didit.example/b.jpg',
    },
  ],
  ip_analyses: [
    {
      status: 'Approved',
      ip_address: '196.188.1.2',
      ip_country_code: 'ET',
      ip_city: 'Addis Ababa',
      is_vpn_or_tor: false,
      is_data_center: false,
    },
  ],
};

describe('didit:inspect', () => {
  const output = inspectDecision(decision, '2026-11-01').join('\n');

  it.each(SECRETS)('never prints %j', (secret) => {
    expect(output).not.toContain(secret);
  });

  it('describes numbers by mask and length only', () => {
    expect(output).toContain('document_number: "999999999999" (12 chars)');
    expect(output).toContain('personal_number: "9999999999999999" (16 chars)');
    expect(output).toContain('fan: "AA99999" (7 chars)');
    expect(output).toContain('native_name: "LLL LLL" (7 chars)');
    expect(output).toContain('note: "AAAAAA-AAAAA" (12 chars)');
    expect(output).toContain('count: (number)');
    expect(output).toContain('fin: "999999999999" (12 chars)');
    expect(output).toContain('holder:\n      name: "AAAAA AAAAAA" (12 chars)');
  });

  it('gives the document classification, checks and warning codes', () => {
    for (const line of [
      'session status: Approved',
      'document_type: Identity Card',
      'document_subtype: ID_CARD_GENERIC',
      'issuing_state: ETH',
      'expiration_date: YYYY-MM-DD, today or later',
      'date_of_issue: YYYY-MM-DD, in the past',
      '- DOCUMENT_EXPIRED (feature ID_VERIFICATION, warning)',
      'status: Approved, method: PASSIVE, score: 98.5',
      'status: Approved, score: 91.2',
      'status: Approved, country: ET, vpn/tor: false, data centre: false',
    ]) {
      expect(output).toContain(line);
    }
  });

  it('gives the implied age, not the date of birth', () => {
    expect(output).toContain('date_of_birth: YYYY-MM-DD; age if Gregorian: 36');
    expect(output).toContain("age (Didit's): 36");
  });

  it('lists other fields by name only', () => {
    expect(output).toMatch(
      /other fields \(names only\): .*address.*first_name.*front_image.*full_name.*mrz.*portrait_image/,
    );
  });

  it('shows what our decision code would read: kinds, never numbers', () => {
    expect(output).toContain('identifiers: fayda_fin, fayda_fan');
    expect(output).toContain('name present: true');
    expect(output).toContain('V4 (Gregorian) says 18+');
    expect(output).toContain('problems: none');
  });

  it('flags a number that fits no Fayda rule as NO_IDENTIFIER (V8)', () => {
    const text = inspectDecision(
      {
        status: 'Approved',
        id_verifications: [
          {
            ...decision.id_verifications[0],
            document_number: 'ET-12345',
            personal_number: null,
          },
        ],
      },
      '2026-11-01',
    ).join('\n');

    expect(text).toContain('document_number: "AA-99999" (8 chars)');
    expect(text).toContain('personal_number: absent');
    expect(text).toContain('identifiers: none');
    expect(text).toContain('problems: NO_IDENTIFIER');
  });

  it('copes with a decision that has no documents', () => {
    expect(inspectDecision({ status: 'Declined' }, '2026-11-01')).toContain(
      'features present: none',
    );
  });

  it('masks a non-code value placed in a code field', () => {
    const text = inspectDecision(
      {
        status: 'Approved',
        id_verifications: [
          { status: 'Approved', document_type: `${NAME} <x>` },
        ],
      },
      '2026-11-01',
    ).join('\n');
    expect(text).not.toContain(NAME);
  });

  describe('mask', () => {
    it.each([
      [null, 'absent'],
      ['', 'empty'],
      [42, '(number)'],
      ['EP 123-4', '"AA 999-9" (8 chars)'],
      ['x'.repeat(40), `"${'A'.repeat(32)}…(+8)" (40 chars)`],
    ])('%j → %s', (value, expected) => {
      expect(mask(value)).toBe(expected);
    });
  });

  it.each([
    ['2008-11-01', 18],
    ['2008-11-02', 17],
    ['2000-02-29', 26],
    ['not a date', null],
  ])('ageOn(%s) on 2026-11-01 → %s', (dob, age) => {
    expect(ageOn(dob, '2026-11-01')).toBe(age);
  });
});
