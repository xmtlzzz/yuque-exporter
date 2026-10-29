import assert from 'assert/strict';

import { visit } from 'unist-util-visit';
import { selectAll } from 'unist-util-select';
import { remark } from 'remark';

describe('tree traversal', () => {
  it('should work', async () => {
    const node = {
      value: 'root',
      children: [
        { value: 'a' },
        { value: 'b', [Symbol.iterator]: myIterator, children: [{ value: 'b1' }, { value: 'b2' }] },
        { value: 'c' },
      ],
      [Symbol.iterator]: myIterator,
    };

    function* myIterator() {
      yield this;
      for (const child of this.children) {
        if (child.children) {
          yield* child;
        } else {
          yield child;
        }
      }
    }

    assert.deepEqual([ ...node ].map(item => item.value), [ 'root', 'a', 'b', 'b1', 'b2', 'c' ]);
  });
});
