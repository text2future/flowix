import { describe, expect, it } from 'vitest';
import { breadcrumbSignature, planBreadcrumbCollapse } from './use-breadcrumb-collapse';

const plan = (itemWidths: number[], availableWidth: number) =>
  planBreadcrumbCollapse({ itemWidths, availableWidth, ellipsisWidth: 24 });

describe('planBreadcrumbCollapse', () => {
  it('leaves the row unfolded when every segment fits', () => {
    expect(plan([60, 40, 40, 80], 232)).toBeNull();
    expect(plan([60, 40, 40, 80], 400)).toBeNull();
  });

  it('does not fold a row with at most two segments', () => {
    expect(plan([60, 400], 100)).toBeNull();
    expect(plan([400], 100)).toBeNull();
  });

  it('treats an unmeasured row as unfolded', () => {
    expect(plan([60, 40, 40, 80], 0)).toBeNull();
  });

  it('keeps the root and the current file and folds everything between', () => {
    expect(plan([60, 40, 40, 80], 150)).toBe(3);
  });

  it('restores the closest parent before shallower ones', () => {
    expect(plan([60, 40, 40, 80], 230)).toBe(2);
    expect(plan([60, 40, 40, 80], 150)).toBe(3);
  });

  it('never restores the second segment, so the marker always means something', () => {
    expect(plan([10, 100, 10], 100)).toBe(2);
  });

  it('counts the gaps between segments against the available width', () => {
    // 100 + 100 + 4 = 204 fits, one pixel less does not.
    expect(plan([100, 100], 204)).toBeNull();
    expect(plan([50, 40, 40], 138)).toBeNull();
    expect(plan([50, 40, 40], 130)).toBe(2);
  });
});

describe('breadcrumbSignature', () => {
  it('changes with labels and with folder/file type', () => {
    expect(breadcrumbSignature([{ label: 'a', type: 'folder' }]))
      .not.toBe(breadcrumbSignature([{ label: 'a', type: 'file' }]));
    expect(breadcrumbSignature([{ label: 'a' }, { label: 'b' }]))
      .not.toBe(breadcrumbSignature([{ label: 'a' }, { label: 'c' }]));
  });

  it('is stable for equal content, so re-renders do not re-measure', () => {
    expect(breadcrumbSignature([{ label: '笔记', type: 'file' }]))
      .toBe(breadcrumbSignature([{ label: '笔记', type: 'file' }]));
  });
});
