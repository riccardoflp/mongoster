import { describe, expect, it } from 'vitest';
import { QUERY_PANE_WIDTH, clampPaneWidth, draggedWidth, keyedWidth, paneLayout, positionOf, readQueryPane } from '../../src/shared/queryPane';

describe('query.pane: the stored choice', () => {
  it('defaults to the query above the results', () => {
    expect(readQueryPane(undefined, undefined)).toEqual({ side: false, width: QUERY_PANE_WIDTH.default });
    expect(readQueryPane('top', 'wide')).toEqual({ side: false, width: QUERY_PANE_WIDTH.default });
  });

  it('puts the query at the right with the setting right, and keeps the stored width', () => {
    expect(readQueryPane('right', { width: 500 })).toEqual({ side: true, width: 500 });
  });

  it('takes the place from the setting only, not from a side stored by an earlier build', () => {
    expect(readQueryPane('top', { side: true, width: 500 })).toEqual({ side: false, width: 500 });
    expect(readQueryPane('left', {}).side).toBe(false);
  });

  it('gives the setting back for a place', () => {
    expect(positionOf({ side: true, width: 380 })).toBe('right');
    expect(positionOf({ side: false, width: 380 })).toBe('top');
  });
});

describe('query.pane: the width', () => {
  it('keeps the width within the limits, rounded', () => {
    expect(clampPaneWidth(10)).toBe(QUERY_PANE_WIDTH.min);
    expect(clampPaneWidth(5000)).toBe(QUERY_PANE_WIDTH.max);
    expect(clampPaneWidth(400.6)).toBe(401);
  });

  it('gives the default for what is not a number', () => {
    expect(clampPaneWidth('400')).toBe(QUERY_PANE_WIDTH.default);
    expect(clampPaneWidth(Number.NaN)).toBe(QUERY_PANE_WIDTH.default);
  });
});

describe('query.pane: above or beside', () => {
  it('stays above when the user chose above', () => {
    expect(paneLayout({ side: false, width: 380 }, 1400)).toEqual({ side: false, width: 380, title: 'Query at the right of the results' });
  });

  it('goes beside when the results keep 360 px', () => {
    expect(paneLayout({ side: true, width: 380 }, 740)).toEqual({ side: true, width: 380, title: 'Query above the results' });
  });

  it('goes back above, and says why, when the tab is too narrow', () => {
    const layout = paneLayout({ side: true, width: 380 }, 739);
    expect(layout.side).toBe(false);
    expect(layout.title).toBe('Query at the right of the results: the tab is too narrow, so it is above them for now');
  });

  it('uses the width within the limits', () => {
    expect(paneLayout({ side: true, width: 5000 }, 3000).width).toBe(QUERY_PANE_WIDTH.max);
  });
});

describe('query.pane: the splitter', () => {
  it('widens the pane at the right when dragged left, narrows it when dragged right', () => {
    expect(draggedWidth(380, -150, 1400)).toBe(530);
    expect(draggedWidth(380, 50, 1400)).toBe(330);
  });

  it('keeps 360 px for the results and the pane at least 260 px', () => {
    expect(draggedWidth(380, -600, 1000)).toBe(640);
    expect(draggedWidth(380, 500, 1400)).toBe(QUERY_PANE_WIDTH.min);
    expect(draggedWidth(380, -600, 500)).toBe(QUERY_PANE_WIDTH.min);
  });

  it('moves the splitter 20 px with the arrows, 60 px with Shift, and ignores other keys', () => {
    expect(keyedWidth(380, 'ArrowLeft', false)).toBe(400);
    expect(keyedWidth(380, 'ArrowRight', true)).toBe(320);
    expect(keyedWidth(270, 'ArrowRight', false)).toBe(QUERY_PANE_WIDTH.min);
    expect(keyedWidth(380, 'Enter', false)).toBeNull();
  });
});
