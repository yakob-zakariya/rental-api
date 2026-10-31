import type { DiditIdVerification } from '../didit/didit.types.js';
import { IdentityKind } from '../verification.enums.js';
import { extractIdentity, IdentityProblem as P } from './identifiers.js';

const FIN = '123456789012'; // 12 digits
const FAN = '1234567890123456'; // 16 digits

const doc = (fields: Partial<DiditIdVerification>): DiditIdVerification => ({
  status: 'Approved',
  documentType: null,
  documentSubtype: null,
  documentNumber: null,
  personalNumber: null,
  issuingState: null,
  dateOfBirth: '1990-05-17',
  fullName: 'Abebe Kebede',
  firstName: null,
  lastName: null,
  ...fields,
});

const fayda = (fields: Partial<DiditIdVerification> = {}) =>
  doc({
    documentType: 'Identity Card',
    documentSubtype: 'ID_CARD_GENERIC',
    issuingState: 'ETH',
    ...fields,
  });
const passport = (fields: Partial<DiditIdVerification> = {}) =>
  doc({
    documentType: 'Passport',
    documentSubtype: 'PASSPORT_GENERIC',
    documentNumber: 'EP1234567',
    issuingState: 'ETH',
    ...fields,
  });

describe('extractIdentity', () => {
  describe('Fayda (Ethiopian identity card)', () => {
    it('reads a 12-digit number as FIN and a 16-digit number as FAN, from either field', () => {
      const result = extractIdentity([
        fayda({ documentNumber: FIN, personalNumber: FAN }),
      ]);

      expect(result.identifiers).toEqual([
        { kind: IdentityKind.FaydaFin, number: FIN },
        { kind: IdentityKind.FaydaFan, number: FAN },
      ]);
      expect(result.problems).toEqual([]);
      expect(result.documentType).toBe('Identity Card');
    });

    it('normalises before measuring (spaces, dashes, full-width digits)', () => {
      const result = extractIdentity([
        fayda({ personalNumber: '1234 5678-9012' }),
        fayda({ documentNumber: '１２３４５６７８９０１２３４５６' }),
      ]);

      expect(result.identifiers).toEqual([
        { kind: IdentityKind.FaydaFin, number: FIN },
        { kind: IdentityKind.FaydaFan, number: FAN },
      ]);
    });

    it.each([
      ['11 digits', '12345678901'],
      ['13 digits', '1234567890123'],
      ['15 digits', '123456789012345'],
      ['17 digits', '12345678901234567'],
      ['letters', 'AB3456789012'],
    ])('ignores a number with %s (never guessed) → V8', (_label, number) => {
      const result = extractIdentity([fayda({ documentNumber: number })]);

      expect(result.identifiers).toEqual([]);
      expect(result.problems).toEqual([P.NoIdentifier]);
    });

    it('keeps the valid number when the other field is unusable', () => {
      const result = extractIdentity([
        fayda({ documentNumber: 'X-1', personalNumber: FIN }),
      ]);

      expect(result.identifiers).toEqual([
        { kind: IdentityKind.FaydaFin, number: FIN },
      ]);
      expect(result.problems).toEqual([]);
    });

    it.each([['KEN'], [null]])(
      'yields nothing for an identity card issued by %s',
      (issuingState) => {
        const result = extractIdentity([
          fayda({ issuingState, documentNumber: FIN }),
        ]);

        expect(result.identifiers).toEqual([]);
        expect(result.problems).toContain(P.NoIdentifier);
      },
    );
  });

  describe('passports', () => {
    it('reads the number with its alpha-3 issuing country', () => {
      const result = extractIdentity([
        passport({ documentNumber: 'ep 123-4567', issuingState: 'eth' }),
      ]);

      expect(result.identifiers).toEqual([
        { kind: IdentityKind.Passport, number: 'EP1234567', country: 'ETH' },
      ]);
      expect(result.problems).toEqual([]);
      expect(result.documentType).toBe('Passport');
    });

    it.each([[null], ['ET'], ['E1H'], ['']])(
      'flags a passport with country %j (V8)',
      (issuingState) => {
        const result = extractIdentity([passport({ issuingState })]);

        expect(result.identifiers).toEqual([]);
        expect(result.problems).toEqual(
          expect.arrayContaining([P.PassportWithoutCountry, P.NoIdentifier]),
        );
      },
    );

    it('flags a passport without country even when a Fayda number is also present (V8)', () => {
      const result = extractIdentity([
        fayda({ documentNumber: FIN }),
        passport({ issuingState: null }),
      ]);

      expect(result.identifiers).toEqual([
        { kind: IdentityKind.FaydaFin, number: FIN },
      ]);
      expect(result.problems).toEqual([P.PassportWithoutCountry]);
    });

    it('ignores a passport with no number', () => {
      expect(
        extractIdentity([passport({ documentNumber: null })]).problems,
      ).toEqual([P.NoIdentifier]);
    });
  });

  it.each(["Driver's License", 'Residence Permit', 'Other', null])(
    'yields no identifier for document type %j (V8)',
    (documentType) => {
      const result = extractIdentity([
        doc({ documentType, issuingState: 'ETH', documentNumber: FIN }),
      ]);

      expect(result.identifiers).toEqual([]);
      expect(result.problems).toEqual([P.NoIdentifier]);
      expect(result.documentType).toBeNull();
    },
  );

  it('reports no identifier and no date of birth for an empty decision', () => {
    expect(extractIdentity([])).toEqual({
      identifiers: [],
      checkOnlyIdentifiers: [],
      fullName: null,
      dateOfBirth: null,
      documentType: null,
      problems: [P.NoIdentifier, P.NoDateOfBirth],
    });
  });

  describe('date of birth', () => {
    it.each([[null], ['17/05/1990'], ['2023-02-29']])(
      'treats %j as missing (V8)',
      (dateOfBirth) => {
        const result = extractIdentity([
          fayda({ documentNumber: FIN, dateOfBirth }),
        ]);

        expect(result.dateOfBirth).toBeNull();
        expect(result.problems).toEqual([P.NoDateOfBirth]);
      },
    );
  });

  describe('name', () => {
    it('uses full_name, else first + last name', () => {
      expect(extractIdentity([fayda({ documentNumber: FIN })]).fullName).toBe(
        'Abebe Kebede',
      );
      expect(
        extractIdentity([
          fayda({
            documentNumber: FIN,
            fullName: null,
            firstName: 'Abebe',
            lastName: 'Kebede',
          }),
        ]).fullName,
      ).toBe('Abebe Kebede');
    });
  });

  describe('a document Didit did not approve (V18)', () => {
    it.each([['Declined'], ['In Review'], ['Not Finished'], [null]])(
      'flags DOCUMENT_DECLINED for per-document status %j',
      (status) => {
        const result = extractIdentity([
          passport(),
          fayda({ documentNumber: FIN, status }),
        ]);

        expect(result.problems).toEqual([P.DocumentDeclined]);
      },
    );

    it('keeps its identifiers apart: check-only, never with the approvable ones', () => {
      const result = extractIdentity([
        passport(),
        fayda({ documentNumber: FIN, personalNumber: FAN, status: 'Declined' }),
      ]);

      expect(result.identifiers).toEqual([
        { kind: IdentityKind.Passport, number: 'EP1234567', country: 'ETH' },
      ]);
      expect(result.checkOnlyIdentifiers).toEqual([
        { kind: IdentityKind.FaydaFin, number: FIN },
        { kind: IdentityKind.FaydaFan, number: FAN },
      ]);
    });

    it('ignores its name and date of birth (no V17 mismatch, not used)', () => {
      const result = extractIdentity([
        passport({ fullName: 'Abebe Kebede', dateOfBirth: '1990-05-17' }),
        fayda({
          documentNumber: FIN,
          status: 'Declined',
          fullName: 'Someone Else',
          dateOfBirth: '1970-01-01',
        }),
      ]);

      expect(result.fullName).toBe('Abebe Kebede');
      expect(result.dateOfBirth).toBe('1990-05-17');
      expect(result.problems).toEqual([P.DocumentDeclined]);
    });

    it('does not use it for the document type', () => {
      const result = extractIdentity([
        fayda({ documentNumber: FIN, status: 'Declined' }),
        passport(),
      ]);

      expect(result.documentType).toBe('Passport');
    });

    it('treats an identifier also on an approved document as a normal one', () => {
      const result = extractIdentity([
        fayda({ documentNumber: FIN }),
        fayda({ personalNumber: FIN, status: 'Declined' }),
      ]);

      expect(result.identifiers).toEqual([
        { kind: IdentityKind.FaydaFin, number: FIN },
      ]);
      expect(result.checkOnlyIdentifiers).toEqual([]);
    });

    it('with only declined documents: no approvable identifier and no date of birth (V8 too)', () => {
      const result = extractIdentity([
        fayda({ documentNumber: FIN, status: 'Declined' }),
      ]);

      expect(result.identifiers).toEqual([]);
      expect(result.checkOnlyIdentifiers).toEqual([
        { kind: IdentityKind.FaydaFin, number: FIN },
      ]);
      expect(result.problems).toEqual(
        expect.arrayContaining([
          P.DocumentDeclined,
          P.NoIdentifier,
          P.NoDateOfBirth,
        ]),
      );
      expect(result.dateOfBirth).toBeNull();
      expect(result.fullName).toBeNull();
    });

    it("ignores a declined passport's missing country (the document isn't used)", () => {
      const result = extractIdentity([
        fayda({ documentNumber: FIN }),
        passport({ issuingState: null, status: 'Declined' }),
      ]);

      expect(result.problems).toEqual([P.DocumentDeclined]);
    });
  });

  describe('several documents (V17)', () => {
    it('collects identifiers from all documents, without duplicates', () => {
      const result = extractIdentity([
        fayda({ documentNumber: FIN }),
        passport(),
        fayda({ personalNumber: FIN, documentNumber: FAN }),
      ]);

      expect(result.identifiers).toEqual([
        { kind: IdentityKind.FaydaFin, number: FIN },
        { kind: IdentityKind.Passport, number: 'EP1234567', country: 'ETH' },
        { kind: IdentityKind.FaydaFan, number: FAN },
      ]);
      expect(result.documentType).toBe('Identity Card'); // the first document with an identifier
      expect(result.problems).toEqual([]);
    });

    it('accepts documents that agree on date of birth and name (after V7 normalisation)', () => {
      const result = extractIdentity([
        fayda({ documentNumber: FIN, fullName: 'ABEBE KEBEDE' }),
        passport({ fullName: 'Abebe  Kebede.' }),
      ]);

      expect(result.problems).toEqual([]);
      expect(result.fullName).toBe('ABEBE KEBEDE');
      expect(result.dateOfBirth).toBe('1990-05-17');
    });

    it('accepts a document with no date of birth or name next to one that has them', () => {
      const result = extractIdentity([
        passport({ dateOfBirth: null, fullName: null }),
        fayda({ documentNumber: FIN }),
      ]);

      expect(result.problems).toEqual([]);
      expect(result.dateOfBirth).toBe('1990-05-17');
      expect(result.fullName).toBe('Abebe Kebede');
    });

    it('flags DOCUMENT_MISMATCH when dates of birth differ', () => {
      const result = extractIdentity([
        fayda({ documentNumber: FIN, dateOfBirth: '1990-05-17' }),
        passport({ dateOfBirth: '1991-05-17' }),
      ]);

      expect(result.problems).toEqual([P.DocumentMismatch]);
    });

    it('flags DOCUMENT_MISMATCH when names differ after normalisation', () => {
      const result = extractIdentity([
        fayda({ documentNumber: FIN, fullName: 'Abebe Kebede' }),
        passport({ fullName: 'Abebe Bikila' }),
      ]);

      expect(result.problems).toEqual([P.DocumentMismatch]);
    });
  });
});
