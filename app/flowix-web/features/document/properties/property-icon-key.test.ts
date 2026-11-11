import { describe, expect, it } from 'vitest';
import { parsePropertyIconKey } from './property-icon-key';

describe('parsePropertyIconKey', () => {
  it('reads the category and id out of a base-relative glob key', () => {
    expect(parsePropertyIconKey('./smileys-emotion/dog-face.svg')).toEqual({
      category: 'smileys-emotion',
      value: 'dog-face',
    });
    expect(parsePropertyIconKey('./all/coffee.svg')).toEqual({ category: 'all', value: 'coffee' });
  });

  it('keeps multi-word ids intact and strips the extension case-insensitively', () => {
    expect(parsePropertyIconKey('./activities/1st-place-medal.svg')?.value).toBe('1st-place-medal');
    expect(parsePropertyIconKey('./activities/1st-place-medal.SVG')?.value).toBe('1st-place-medal');
  });

  it('rejects keys that are not two segments deep', () => {
    // The full-path key shape this module used to receive must fail loudly here
    // instead of silently emptying the picker.
    expect(parsePropertyIconKey('../../../assets/property-icons/emoji/activities/dog-face.svg')).toBeNull();
    expect(parsePropertyIconKey('./nested/all/coffee.svg')).toBeNull();
    expect(parsePropertyIconKey('./svg')).toBeNull();
  });
});
