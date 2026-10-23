// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const charge = require('../charge');

const VISA = '4432801561520454';
const MASTERCARD = '5555555555554444';
const AMEX = '378282246310005';
const DISCOVER = '6011111111111117';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function request ({ number = VISA, year = 2030, month = 1 } = {}) {
  return {
    amount: { currency_code: 'USD', units: 100, nanos: 990000000 },
    credit_card: {
      credit_card_number: number,
      credit_card_cvv: 123,
      credit_card_expiration_year: year,
      credit_card_expiration_month: month
    }
  };
}

function assertCreditCardError (fn, message) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, 400);
    assert.match(err.message, message);
    return true;
  });
}

describe('charge', () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: new Date(2026, 5, 15) });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it('charges a valid VISA card and returns a v4 uuid transaction id', () => {
    const response = charge(request({ number: VISA }));
    assert.deepEqual(Object.keys(response), ['transaction_id']);
    assert.match(response.transaction_id, UUID_RE);
  });

  it('charges a valid MasterCard', () => {
    assert.match(charge(request({ number: MASTERCARD })).transaction_id, UUID_RE);
  });

  it('accepts card numbers containing dashes', () => {
    assert.match(charge(request({ number: '4111-1111-1111-1111' })).transaction_id, UUID_RE);
  });

  it('returns a unique transaction id per charge', () => {
    const ids = new Set(Array.from({ length: 20 }, () => charge(request()).transaction_id));
    assert.equal(ids.size, 20);
  });

  it('rejects a card number that fails validation', () => {
    assertCreditCardError(() => charge(request({ number: '1234' })), /^Credit card info is invalid$/);
  });

  it('rejects a card number that fails the Luhn check', () => {
    assertCreditCardError(() => charge(request({ number: '4432801561520455' })), /^Credit card info is invalid$/);
  });

  it('rejects an empty card number', () => {
    assertCreditCardError(() => charge(request({ number: '' })), /^Credit card info is invalid$/);
  });

  it('rejects a missing card number', () => {
    const req = request();
    delete req.credit_card.credit_card_number;
    assertCreditCardError(() => charge(req), /^Credit card info is invalid$/);
  });

  it('rejects a request without credit card info', () => {
    const req = request();
    delete req.credit_card;
    assertCreditCardError(() => charge(req), /^Credit card info is invalid$/);
  });

  it('rejects a request with null credit card info', () => {
    assertCreditCardError(() => charge({ ...request(), credit_card: null }), /^Credit card info is invalid$/);
  });

  it('rejects a request without an amount', () => {
    assertCreditCardError(() => charge({ ...request(), amount: null }), /^Charge amount is missing$/);
  });

  for (const [type, number] of [['amex', AMEX], ['discover', DISCOVER]]) {
    it(`rejects ${type} cards as unaccepted`, () => {
      assertCreditCardError(
        () => charge(request({ number })),
        new RegExp(`^Sorry, we cannot process ${type} credit cards\\. Only VISA or MasterCard is accepted\\.$`)
      );
    });
  }

  it('rejects a card that expired in a previous year', () => {
    assertCreditCardError(
      () => charge(request({ year: 2025, month: 12 })),
      /^Your credit card \(ending 0454\) expired on 12\/2025$/
    );
  });

  it('rejects a card that expired earlier in the current year', () => {
    assertCreditCardError(
      () => charge(request({ year: 2026, month: 5 })),
      /expired on 5\/2026$/
    );
  });

  it('accepts a card expiring in the current month', () => {
    assert.match(charge(request({ year: 2026, month: 6 })).transaction_id, UUID_RE);
  });

  it('accepts a card expiring next month', () => {
    assert.match(charge(request({ year: 2026, month: 7 })).transaction_id, UUID_RE);
  });

  it('reports the last four digits of a dashed card number when expired', () => {
    assertCreditCardError(
      () => charge(request({ number: '4111-1111-1111-1111', year: 2020, month: 1 })),
      /^Your credit card \(ending 1111\) expired on 1\/2020$/
    );
  });

  it('validates the card before checking acceptance or expiry', () => {
    assertCreditCardError(
      () => charge(request({ number: '378282246310006', year: 2000, month: 1 })),
      /^Credit card info is invalid$/
    );
  });

  it('checks card type before expiry', () => {
    assertCreditCardError(
      () => charge(request({ number: AMEX, year: 2000, month: 1 })),
      /cannot process amex/
    );
  });
});
