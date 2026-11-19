import { describe, expect, it } from 'vitest';
import { describeFrom, whereFrom, type ElementLike } from './where';

describe('whereFrom', () => {
  it('keeps only the parts that apply to the page', () => {
    expect(whereFrom({ page: 'conversation', org: 'Anjou', project: 'PearDrive', conversation: 'Share row' })).toEqual({ page: 'conversation', org: 'Anjou', project: 'PearDrive', conversation: 'Share row' });
    expect(whereFrom({ page: 'home', org: null, project: 'PearDrive', conversation: 'Share row' })).toEqual({ page: 'home', project: 'PearDrive' });
    expect(whereFrom({ page: 'settings', project: 'PearDrive', conversation: 'x' })).toEqual({ page: 'settings', project: 'PearDrive' });
    expect(whereFrom({ page: 'files', project: 'PearDrive', conversation: 'General' })).toEqual({ page: 'files', project: 'PearDrive', conversation: 'General' });
  });
});

function el(attrs: Record<string, string>, parent?: ElementLike): ElementLike {
  const self: ElementLike = {
    getAttribute: (n) => attrs[n] ?? null,
    closest: (sel) => {
      const m = sel.match(/^\[([a-z-]+)(\$=)?"?([^"\]]*)"?\]$/);
      if (m) {
        const [, name, op, val] = m;
        const v = attrs[name];
        if (v != null && (!op || (op === '$=' && v.endsWith(val)))) return self;
      }
      return parent?.closest?.(sel) ?? null;
    },
  };
  return self;
}

describe('describeFrom', () => {
  it('names a project row, a conversation row and a message', () => {
    const project = el({ 'data-project': 'PearDrive' });
    expect(describeFrom(el({}, project), project)).toEqual({ text: 'project PearDrive' });
    const conv = el({ 'data-conversation': 'Share row', 'data-project': 'PearDrive' }, project);
    expect(describeFrom(el({}, conv), conv)).toEqual({ text: 'conversation Share row', data: { project: 'PearDrive' } });
    const msg = el({ 'aria-label': 'rkeychat: Done, 1 file changed. Actions' });
    expect(describeFrom(msg, msg)).toEqual({ text: 'message by rkeychat' });
    expect(describeFrom(el({}), el({}))).toBeNull();
  });
});
