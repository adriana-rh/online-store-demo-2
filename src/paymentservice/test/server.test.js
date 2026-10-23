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

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const grpc = require('@grpc/grpc-js');

const HipsterShopServer = require('../server');

const PROTO_PATH = path.join(__dirname, '..', 'proto');
const VALID_CARD = {
  credit_card_number: '4432801561520454',
  credit_card_cvv: 672,
  credit_card_expiration_year: new Date().getFullYear() + 5,
  credit_card_expiration_month: 1
};
const AMOUNT = { currency_code: 'USD', units: 10, nanos: 500000000 };

describe('HipsterShopServer handlers', () => {
  before(() => {
    mock.method(console, 'warn', () => {});
  });

  after(() => {
    mock.restoreAll();
  });

  it('ChargeServiceHandler returns a transaction id for a valid card', (t, done) => {
    HipsterShopServer.ChargeServiceHandler(
      { request: { amount: AMOUNT, credit_card: VALID_CARD } },
      (err, response) => {
        assert.equal(err, null);
        assert.equal(typeof response.transaction_id, 'string');
        done();
      }
    );
  });

  it('ChargeServiceHandler passes charge errors to the callback', (t, done) => {
    HipsterShopServer.ChargeServiceHandler(
      { request: { amount: AMOUNT, credit_card: { ...VALID_CARD, credit_card_number: '1234' } } },
      (err, response) => {
        assert.equal(err.code, 400);
        assert.equal(err.message, 'Credit card info is invalid');
        assert.equal(response, undefined);
        done();
      }
    );
  });

  it('CheckHandler reports SERVING', (t, done) => {
    HipsterShopServer.CheckHandler({}, (err, response) => {
      assert.equal(err, null);
      assert.deepEqual(response, { status: 'SERVING' });
      done();
    });
  });
});

describe('HipsterShopServer over gRPC', () => {
  let shopServer;
  let paymentClient;
  let healthClient;

  before(async () => {
    mock.method(console, 'warn', () => {});
    shopServer = new HipsterShopServer(PROTO_PATH);
    const port = await new Promise((resolve, reject) => {
      shopServer.server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(),
        (err, boundPort) => (err ? reject(err) : resolve(boundPort)));
    });
    const address = `127.0.0.1:${port}`;
    const credentials = grpc.credentials.createInsecure();
    const { hipstershop } = shopServer.packages.hipsterShop;
    const healthPackage = shopServer.packages.health.grpc.health.v1;
    paymentClient = new hipstershop.PaymentService(address, credentials);
    healthClient = new healthPackage.Health(address, credentials);
  });

  after(() => {
    paymentClient.close();
    healthClient.close();
    shopServer.server.forceShutdown();
    mock.restoreAll();
  });

  function chargeRpc (request) {
    return new Promise((resolve, reject) => {
      paymentClient.charge(request, (err, response) => (err ? reject(err) : resolve(response)));
    });
  }

  it('charges a valid card', async () => {
    const response = await chargeRpc({ amount: AMOUNT, credit_card: VALID_CARD });
    assert.match(response.transaction_id, /^[0-9a-f-]{36}$/);
  });

  it('returns an error status for an unaccepted card type', async () => {
    await assert.rejects(
      chargeRpc({ amount: AMOUNT, credit_card: { ...VALID_CARD, credit_card_number: '378282246310005' } }),
      (err) => {
        assert.match(err.details, /cannot process amex credit cards/);
        return true;
      }
    );
  });

  it('returns an error status for an expired card', async () => {
    await assert.rejects(
      chargeRpc({ amount: AMOUNT, credit_card: { ...VALID_CARD, credit_card_expiration_year: 2000 } }),
      (err) => {
        assert.match(err.details, /^Your credit card \(ending 0454\) expired on 1\/2000$/);
        return true;
      }
    );
  });

  it('returns an invalid card error for an empty card number', async () => {
    await assert.rejects(
      chargeRpc({ amount: AMOUNT, credit_card: { ...VALID_CARD, credit_card_number: '' } }),
      (err) => {
        assert.equal(err.details, 'Credit card info is invalid');
        return true;
      }
    );
  });

  it('returns an invalid card error when credit card info is omitted', async () => {
    await assert.rejects(chargeRpc({ amount: AMOUNT }), (err) => {
      assert.equal(err.details, 'Credit card info is invalid');
      return true;
    });
  });

  it('returns an error when the amount is omitted', async () => {
    await assert.rejects(chargeRpc({ credit_card: VALID_CARD }), (err) => {
      assert.equal(err.details, 'Charge amount is missing');
      return true;
    });
  });

  it('serves the health check', async () => {
    const response = await new Promise((resolve, reject) => {
      healthClient.check({ service: 'hipstershop.PaymentService' },
        (err, res) => (err ? reject(err) : resolve(res)));
    });
    assert.equal(response.status, 'SERVING');
  });
});
