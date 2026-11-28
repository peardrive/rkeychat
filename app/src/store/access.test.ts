import { describe, expect, it } from 'vitest';
import { accessItems } from './access';

describe('folders this project can see', () => {
  it('lists the folder, what is beside it, then each grant with where it came from', () => {
    const items = accessItems({
      folder: '/Users/guy/rKeyChat/memo-by-anjou',
      beside: '/Users/guy/rKeyChat',
      home: '/Users/guy',
      owner: true,
      grants: [
        { rule: 'Read(//Users/guy/Anjou/**)', label: 'read anything in ~/Anjou', by: 'guy', ts: 1, from: 'ask' },
        { rule: 'Edit(//Users/guy/Anjou/pearkit/**)', label: 'change files in ~/Anjou/pearkit', by: 'guy', ts: 2, from: 'settings' },
        { rule: 'Bash(jq:*)', label: 'run jq commands', by: 'guy', ts: 3, from: 'ask' },
      ],
    });
    expect(items.map((i) => [i.title, i.detail, !!i.fixed])).toEqual([
      ['~/rKeyChat/memo-by-anjou', 'the project folder', true],
      ['~/rKeyChat', 'beside the project, except its _ folders', true],
      ['~/Anjou', 'allowed from a question, by guy', false],
      ['~/Anjou/pearkit', 'may change files · added by guy', false],
      ['run jq commands', 'allowed from a question, by guy', false],
    ]);
    expect(items[4]).toMatchObject({ id: 'Bash(jq:*)', icon: 'tick', path: false });
  });

  it('on a device without the folder, only the grants', () => {
    expect(accessItems({ folder: null, beside: null, owner: true, grants: [] })).toEqual([]);
  });
});
