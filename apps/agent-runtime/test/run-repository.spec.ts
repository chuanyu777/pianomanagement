import { describe, expect, it } from 'vitest';
import { createAgentRuntimeRepository } from '../src/persistence/repository.js';

describe('agent runtime repository', () => {
  it('exposes persistent run and event operations', () => {
    const repository = createAgentRuntimeRepository({
      connectionString: 'postgresql://unused',
    });

    expect(repository).toHaveProperty('createRun');
    expect(repository).toHaveProperty('findRun');
    expect(repository).toHaveProperty('claimRunForResume');
    expect(repository).toHaveProperty('appendEvent');
    expect(repository).toHaveProperty('listEvents');
    expect(repository).toHaveProperty('close');
  });
});
