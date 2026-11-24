import { findContacts } from './contact-detection.js';

describe('findContacts (R1 CONTACT_IN_TEXT, decided 2026-11-24)', () => {
  describe('phone numbers', () => {
    it.each([
      'Call 0911234567 for viewing',
      'Call 0911 23 45 67',
      'ስልክ: 091-123-4567',
      'Phone (0911) 234 567',
      '+251 911 234 567',
      '+251-911-234-567',
      '251911234567',
      'Safaricom: 0712345678',
      'ለበለጠ መረጃ 0911.234.567 ይደውሉ',
      'Rent 25000, call 0911234567 25000 is fixed',
    ])('finds the phone in %j', (text) => {
      expect(findContacts(text)).toEqual(['phone']);
    });

    it.each([
      'Monthly rent 25000 birr, 2 months advance',
      'Rent: 1,500,000 birr for the villa',
      '4th floor, built in 2016, 120 m²',
      'Condominium block 23, house 405',
      'የወር ኪራይ 18000 ብር፣ የ3 ወር ቅድመ ክፍያ',
      'Landline 0111 234 567', // not a mobile: not how brokers reach people, and not flagged
      'ID shown on viewing: 1234 5678 9012', // 12 digits, not a phone
    ])('finds nothing in %j', (text) => {
      expect(findContacts(text)).toEqual([]);
    });
  });

  describe('Telegram', () => {
    it.each([
      'Message me on Telegram @AddisHomes',
      'telegram: @bole_rentals_2024',
      'በቴሌግራም ያግኙን @AddisBetoch',
      'Join t.me/addishomes for more houses',
      'https://t.me/AddisRentals',
      'ለበለጠ ፎቶ t.me/joinchat/AbCdEf123 ይቀላቀሉ',
      'telegram.me/brokerbole',
      'tg://resolve?domain=brokerbole',
    ])('finds Telegram in %j', (text) => {
      expect(findContacts(text)).toEqual(['telegram']);
    });

    it.each([
      'Near @ the Edna Mall roundabout', // a bare @
      'Rent @ 25000 birr', // @ before a number
      '@abc is too short for a username',
      'ቦሌ @ ኤድና ሞል አጠገብ',
    ])('finds nothing in %j', (text) => {
      expect(findContacts(text)).toEqual([]);
    });
  });

  describe('emails and links', () => {
    it.each([
      ['Email abebe.k@gmail.com', ['email']],
      ['ኢሜይል፡ abebe@yahoo.com', ['email']],
      ['See more at https://bole-homes.com/listing/12', ['url']],
      ['www.addishouses.et', ['url']],
      ['Visit bolerentals.com today', ['url']],
      ['Photos on facebook.com/addishomes', ['url']],
    ])('%j → %j', (text, kinds) => {
      expect(findContacts(text)).toEqual(kinds);
    });

    it.each([
      'Bright flat. Near the school.', // sentences, not domains
      'Ground floor, 2 bed. Parking available.',
      'ብሩህ ቤት። ለትምህርት ቤት ቅርብ።',
    ])('finds nothing in %j', (text) => {
      expect(findContacts(text)).toEqual([]);
    });
  });

  it('several kinds at once, each once, in a fixed order', () => {
    expect(
      findContacts(
        'Call 0911234567 or 0922334455, Telegram @AddisHomes or t.me/addishomes, email a@b.com, site addishomes.com',
      ),
    ).toEqual(['phone', 'telegram', 'email', 'url']);
  });

  it('an email address is not also counted as a Telegram handle', () => {
    expect(findContacts('abebe_kebede@gmail.com')).toEqual(['email']);
  });

  it('full-width digits are read as digits', () => {
    expect(findContacts('０９１１２３４５６７')).toEqual(['phone']);
  });
});
