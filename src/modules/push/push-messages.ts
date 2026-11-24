import { PropertyType, StaffReasonCode } from '../listings/listings.enums.js';
import { UserLanguage } from '../users/user.enums.js';
import type { PushMessage } from './push-sender.js';

// Every push text, in English and Amharic (spec N3; T6.1). The Amharic is a draft by Claude for
// the user to review, in the polite form (እርስዎ: respectful and gender-neutral; decided
// 2026-11-24). Afaan Oromo users get English until it's added.
//
// N4: a push never contains a phone number, a name or a location. A notice is built only from the
// listing's id, its property type, its neighbourhood's name and a reason code; nothing else can
// reach the text.

/** The four Phase 2 notices (N5); `listingId` opens the listing in the app. */
export type PushNotice =
  | ({ kind: 'weekly_check' } & ListingRef)
  | ({ kind: 'listing_approved' } & ListingRef)
  | ({ kind: 'listing_rejected'; reasonCode: StaffReasonCode } & ListingRef)
  | ({ kind: 'listing_taken_down'; reasonCode: StaffReasonCode } & ListingRef);

export interface ListingRef {
  listingId: string;
  type: PropertyType;
  neighbourhood: { nameEn: string; nameAm: string };
}

type Language = 'en' | 'am';

const TYPES: Record<PropertyType, Record<Language, string>> = {
  [PropertyType.Condominium]: { en: 'condominium', am: 'ኮንዶሚኒየም' },
  [PropertyType.Apartment]: { en: 'apartment', am: 'አፓርታማ' },
  [PropertyType.VillaHouse]: { en: 'house', am: 'ቪላ ቤት' },
  [PropertyType.CompoundRoom]: { en: 'room in a compound', am: 'ሰርቪስ ክፍል' },
  [PropertyType.Studio]: { en: 'studio', am: 'ስቱዲዮ' },
};

/** GUIDELINES stays neutral (hard rule 10): suspected fraud is never explained. */
const REASONS: Record<StaffReasonCode, Record<Language, string>> = {
  [StaffReasonCode.PhotosUnclear]: {
    en: 'the photos are unclear',
    am: 'ፎቶዎቹ ግልጽ አይደሉም',
  },
  [StaffReasonCode.PhotosDontMatch]: {
    en: "the photos don't match the description",
    am: 'ፎቶዎቹ ከመግለጫው ጋር አይመሳሰሉም',
  },
  [StaffReasonCode.WrongLocation]: {
    en: 'the location looks wrong',
    am: 'የተመረጠው ቦታ ትክክል አይመስልም',
  },
  [StaffReasonCode.MissingInformation]: {
    en: 'some information is missing',
    am: 'አንዳንድ መረጃዎች ይጎድላሉ',
  },
  [StaffReasonCode.DuplicateListing]: {
    en: 'this home is already listed',
    am: 'ይህ ቤት ቀድሞ ተመዝግቧል',
  },
  [StaffReasonCode.Guidelines]: {
    en: "it didn't meet our guidelines",
    am: 'መመሪያዎቻችንን አላሟላም',
  },
};

type Texts = (n: { type: string; place: string; reason: string }) => {
  title: string;
  body: string;
};

const TEXTS: Record<PushNotice['kind'], Record<Language, Texts>> = {
  weekly_check: {
    en: ({ type, place }) => ({
      title: 'Is your home still for rent?',
      body: `Your ${type} in ${place}: confirm it's still available, or close the listing.`,
    }),
    am: ({ type, place }) => ({
      title: 'ቤትዎ አሁንም ለኪራይ ዝግጁ ነው?',
      // The home is for rent, not the advertisement (the user's correction, 2026-11-24).
      body: `በ${place} የሚገኘው ${type}ዎ አሁንም ለኪራይ ክፍት መሆኑን ያረጋግጡ፤ ከተከራየ ማስታወቂያውን ይዝጉ።`,
    }),
  },
  listing_approved: {
    en: ({ type, place }) => ({
      title: 'Your listing is live',
      body: `Your ${type} in ${place} is now visible to tenants.`,
    }),
    am: ({ type, place }) => ({
      title: 'ማስታወቂያዎ ጸድቋል',
      body: `በ${place} የሚገኘው የ${type} ማስታወቂያዎ አሁን ለተከራዮች ይታያል።`,
    }),
  },
  listing_rejected: {
    en: ({ type, place, reason }) => ({
      title: 'Your listing needs changes',
      body: `Your ${type} in ${place} wasn't approved: ${reason}. Open the app to fix it.`,
    }),
    am: ({ type, place, reason }) => ({
      title: 'ማስታወቂያዎ ማስተካከያ ያስፈልገዋል',
      body: `በ${place} የሚገኘው የ${type} ማስታወቂያዎ አልጸደቀም፦ ${reason}። ለማስተካከል መተግበሪያውን ይክፈቱ።`,
    }),
  },
  listing_taken_down: {
    en: ({ type, place, reason }) => ({
      title: 'Your listing was removed',
      body: `Your ${type} in ${place} was taken down: ${reason}.`,
    }),
    am: ({ type, place, reason }) => ({
      title: 'ማስታወቂያዎ ተወግዷል',
      // Starts with the reason; the title already says ተወግዷል (the user's correction, 2026-11-24).
      body: `${reason}፤ በ${place} የሚገኘው የ${type} ማስታወቂያዎ ከአሁን በኋላ ለተከራዮች አይታይም።`,
    }),
  },
};

/** `npm run push:send-test`: checks a phone receives pushes. The app ignores `type: test`. */
export function testPushMessage(preferredLanguage: UserLanguage): PushMessage {
  return preferredLanguage === UserLanguage.Amharic
    ? {
        title: 'የሙከራ ማሳወቂያ',
        body: 'ማሳወቂያዎች በዚህ ስልክ ላይ ይሰራሉ።',
        data: { type: 'test' },
      }
    : {
        title: 'Test notification',
        body: 'Notifications work on this phone.',
        data: { type: 'test' },
      };
}

/** The push for a notice, in the user's language (Afaan Oromo: English for now). */
export function pushMessage(
  notice: PushNotice,
  preferredLanguage: UserLanguage,
): PushMessage {
  const lang: Language =
    preferredLanguage === UserLanguage.Amharic ? 'am' : 'en';
  const reason = 'reasonCode' in notice ? REASONS[notice.reasonCode][lang] : '';
  const { title, body } = TEXTS[notice.kind][lang]({
    type: TYPES[notice.type][lang],
    place:
      lang === 'am' ? notice.neighbourhood.nameAm : notice.neighbourhood.nameEn,
    reason,
  });
  return {
    title,
    body,
    data: { type: notice.kind, listingId: notice.listingId },
  };
}
