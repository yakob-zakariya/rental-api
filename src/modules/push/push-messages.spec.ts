import { charCount } from '../../common/validators.js';
import { PropertyType, StaffReasonCode } from '../listings/listings.enums.js';
import { UserLanguage } from '../users/user.enums.js';
import { type PushNotice, pushMessage } from './push-messages.js';

const ref = {
  listingId: '0b9d6e3a-2f4c-4a8b-8c1d-7e6f5a4b3c2d',
  type: PropertyType.Apartment,
  neighbourhood: { nameEn: 'Bole', nameAm: 'ቦሌ' },
};

const NOTICES: PushNotice[] = [
  { kind: 'weekly_check', ...ref },
  { kind: 'listing_approved', ...ref },
  { kind: 'listing_stale', ...ref },
  {
    kind: 'listing_rejected',
    reasonCode: StaffReasonCode.PhotosUnclear,
    ...ref,
  },
  {
    kind: 'listing_taken_down',
    reasonCode: StaffReasonCode.Guidelines,
    ...ref,
  },
];

describe('push texts (N3, N4)', () => {
  it.each(NOTICES.map((n) => [n.kind, n] as const))(
    '%s: in English and Amharic, naming the listing by type and neighbourhood, opening it in the app',
    (_kind, notice) => {
      const en = pushMessage(notice, UserLanguage.English);
      const am = pushMessage(notice, UserLanguage.Amharic);

      expect(en.body).toContain('apartment');
      expect(en.body).toContain('Bole');
      expect(am.body).toContain('አፓርታማ');
      expect(am.body).toContain('ቦሌ');
      expect(am.title).not.toEqual(en.title);
      expect(en.data).toEqual({ type: notice.kind, listingId: ref.listingId });
      expect(am.data).toEqual(en.data);
    },
  );

  it('Afaan Oromo users get English for now', () => {
    expect(pushMessage(NOTICES[1], UserLanguage.AfaanOromo)).toEqual(
      pushMessage(NOTICES[1], UserLanguage.English),
    );
  });

  it('short enough for a phone notification: titles ≤ 50, bodies ≤ 180 characters', () => {
    for (const notice of NOTICES)
      for (const type of Object.values(PropertyType))
        for (const lang of [UserLanguage.English, UserLanguage.Amharic]) {
          const m = pushMessage(
            {
              ...notice,
              type,
              neighbourhood: {
                nameEn: 'Gerji Mebrat Hail',
                nameAm: 'ገርጂ መብራት ኃይል',
              },
            },
            lang,
          );
          expect(charCount(m.title)).toBeLessThanOrEqual(50);
          expect(charCount(m.body)).toBeLessThanOrEqual(180);
        }
  });

  it('every reason code has a text in both languages; GUIDELINES says nothing more (hard rule 10)', () => {
    for (const reasonCode of Object.values(StaffReasonCode)) {
      const en = pushMessage(
        { kind: 'listing_rejected', reasonCode, ...ref },
        UserLanguage.English,
      );
      const am = pushMessage(
        { kind: 'listing_rejected', reasonCode, ...ref },
        UserLanguage.Amharic,
      );
      expect(en.body).not.toContain('undefined');
      expect(am.body).not.toContain('undefined');
    }
    expect(
      pushMessage(
        {
          kind: 'listing_taken_down',
          reasonCode: StaffReasonCode.Guidelines,
          ...ref,
        },
        UserLanguage.English,
      ).body,
    ).toBe(
      "Your apartment in Bole was taken down: it didn't meet our guidelines.",
    );
  });

  it('the stale notice, as asked (2026-11-24)', () => {
    expect(pushMessage(NOTICES[2], UserLanguage.English)).toEqual({
      title: 'Your listing is hidden',
      body: "Your apartment in Bole is hidden because it wasn't confirmed. Tap to show it again.",
      data: { type: 'listing_stale', listingId: ref.listingId },
    });
  });

  it('the Amharic stale notice as reviewed (2026-11-24)', () => {
    expect(pushMessage(NOTICES[2], UserLanguage.Amharic)).toMatchObject({
      title: 'ማስታወቂያዎ ተደብቋል',
      body: 'በቦሌ የሚገኘው የአፓርታማ ማስታወቂያዎ አሁንም ለኪራይ ክፍት መሆኑን ስላላረጋገጡ ለተከራዮች አይታይም። እንደገና እንዲታይ ይንኩ።',
    });
  });

  it('the Amharic wording as reviewed (2026-11-24)', () => {
    expect(pushMessage(NOTICES[0], UserLanguage.Amharic).body).toBe(
      'በቦሌ የሚገኘው አፓርታማዎ አሁንም ለኪራይ ክፍት መሆኑን ያረጋግጡ፤ ከተከራየ ማስታወቂያውን ይዝጉ።',
    );
    expect(
      pushMessage(
        { ...NOTICES[0], type: PropertyType.CompoundRoom },
        UserLanguage.Amharic,
      ).body,
    ).toContain('ሰርቪስ ክፍልዎ');
    const takenDown = pushMessage(NOTICES[4], UserLanguage.Amharic);
    expect(takenDown.title).toBe('ማስታወቂያዎ ተወግዷል');
    expect(takenDown.body).toBe(
      'መመሪያዎቻችንን አላሟላም፤ በቦሌ የሚገኘው የአፓርታማ ማስታወቂያዎ ከአሁን በኋላ ለተከራዮች አይታይም።',
    );
    expect(takenDown.body).not.toContain('ተወግዷል');
  });

  it('N4: nothing but the type, the neighbourhood and the reason can reach the text', () => {
    // Personal details smuggled onto the notice object are ignored: the function reads only
    // the fields of PushNotice.
    const smuggled = {
      ...NOTICES[0],
      phone: '+251911234567',
      listerName: 'Yakob Zekariya Aman',
      location: { lat: 9.0102, lng: 38.7606 },
      landmark: 'Blue gate behind the pharmacy',
    } as unknown as PushNotice;

    for (const lang of [UserLanguage.English, UserLanguage.Amharic]) {
      const text = JSON.stringify(pushMessage(smuggled, lang));
      for (const secret of [
        '0911234567',
        '911234567',
        'Yakob',
        'Zekariya',
        '9.0102',
        '38.7606',
        'Blue gate',
      ])
        expect(text).not.toContain(secret);
    }
  });
});
