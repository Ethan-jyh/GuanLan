import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JevClient, JevClientError } from '../src/tools/jev-client.js';

describe('Task 2: TypeSafe Jev HTTP Client', () => {
  it('should throw immediately when API key is missing', async () => {
    const client = new JevClient({ apiKey: undefined });
    delete process.env.TYPESAFE_API_KEY;

    await assert.rejects(
      async () => {
        await client.classifySentiment({ text: '好消息', target: '某通报' });
      },
      (err: any) => {
        assert.ok(err instanceof JevClientError);
        assert.equal(err.statusCode, 401);
        assert.ok(err.message.includes('TYPESAFE_API_KEY is missing'));
        return true;
      }
    );
  });

  it('should successfully call transport and parse Jev response', async () => {
    let capturedBody: any = null;
    let capturedHeaders: any = null;

    const mockTransport = async (url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      capturedHeaders = init.headers as any;

      return new Response(
        JSON.stringify({
          model: 'jev-2026-09',
          answers: {
            sentiment: {
              choice: 'positive',
              probabilities: { positive: 0.9, neutral: 0.05, negative: 0.05 },
              confidence: 0.9,
              rationale: '态度高度赞扬',
            },
          },
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const client = new JevClient({
      apiKey: 'test-secret-key',
      transport: mockTransport as any,
    });

    const res = await client.classifySentiment({
      text: '救援人员太棒了！',
      target: '防汛救灾工作',
      context: '某地汛情背景',
    });

    assert.equal(res.ok, true);
    assert.equal(res.choice, 'positive');
    assert.equal(res.confidence, 0.9);
    assert.equal(res.actualModel, 'jev-2026-09');
    assert.equal(res.usage?.totalTokens, 120);

    // Verify request payload
    assert.equal(capturedBody.model, 'jev-latest');
    assert.equal(capturedBody.state.target, '防汛救灾工作');
    assert.equal(capturedBody.state.text, '救援人员太棒了！');
    assert.equal(capturedHeaders.Authorization, 'Bearer test-secret-key');
  });

  it('should fail fast on 401 unauthorized without retrying', async () => {
    let callCount = 0;
    const mockTransport = async () => {
      callCount++;
      return new Response('Unauthorized key', { status: 401 });
    };

    const client = new JevClient({
      apiKey: 'invalid-key',
      maxRetries: 2,
      transport: mockTransport as any,
    });

    await assert.rejects(
      async () => {
        await client.classifySentiment({ text: '测试', target: '目标' });
      },
      (err: any) => {
        assert.equal(err.statusCode, 401);
        return true;
      }
    );

    assert.equal(callCount, 1, 'Should not retry on 401');
  });

  it('should retry on 500 error and succeed if subsequent attempt succeeds', async () => {
    let callCount = 0;
    const mockTransport = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('Internal Server Error', { status: 500 });
      }
      return new Response(
        JSON.stringify({
          model: 'jev-latest',
          answers: {
            sentiment: {
              choice: 'negative',
              confidence: 0.85,
            },
          },
        }),
        { status: 200 }
      );
    };

    const client = new JevClient({
      apiKey: 'valid-key',
      maxRetries: 2,
      transport: mockTransport as any,
      sleepFn: async () => {}, // Instant sleep for tests
    });

    const res = await client.classifySentiment({ text: '太慢了差评', target: '物资发放' });
    assert.equal(res.ok, true);
    assert.equal(res.choice, 'negative');
    assert.equal(res.attempts, 2);
    assert.equal(callCount, 2);
  });
});
