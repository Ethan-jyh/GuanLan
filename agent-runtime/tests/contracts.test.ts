import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateResearchFixture,
  ResearchRole,
  VerificationStatus,
  type ResearchResult,
} from '../src/contracts/research.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('TypeScript Research Contracts Validation', () => {
  it('should load and validate the shared fixture research-v1.json', () => {
    const fixturePath = path.resolve(__dirname, '../../../contracts/fixtures/research-v1.json');
    assert.ok(fs.existsSync(fixturePath), `Fixture must exist at ${fixturePath}`);

    const raw = fs.readFileSync(fixturePath, 'utf-8');
    const parsed = JSON.parse(raw);

    const validated = validateResearchFixture(parsed);
    assert.equal(validated.run.run_id, 'run-20261001-001');
    assert.equal(validated.results.length, 3);
    assert.equal(validated.results[0]?.role, ResearchRole.Authority);
    assert.equal(validated.results[1]?.role, ResearchRole.Evolution);
    assert.equal(validated.results[2]?.role, ResearchRole.Feedback);
  });

  it('should reject invalid role in TypeScript validator', () => {
    const invalidResult = {
      role: 'unknown_role',
      round: 1,
      claims: [],
      evidence_pool: [],
      scope: {},
    };

    assert.throws(
      () => {
        validateResearchFixture({
          run: { run_id: 'r1' },
          tasks: [],
          results: [invalidResult as unknown as ResearchResult],
          verifications: [],
        });
      },
      /Invalid role/i
    );
  });

  it('should reject round exceeding 3', () => {
    const invalidRoundResult = {
      role: ResearchRole.Authority,
      round: 4,
      claims: [],
      evidence_pool: [],
      scope: {},
    };

    assert.throws(
      () => {
        validateResearchFixture({
          run: { run_id: 'r1' },
          tasks: [],
          results: [invalidRoundResult as unknown as ResearchResult],
          verifications: [],
        });
      },
      /Round cannot exceed 3/i
    );
  });
});
