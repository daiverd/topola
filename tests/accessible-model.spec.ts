/// <reference path="./jsdom-global.d.ts" />
import * as jsdomGlobal from 'jsdom-global';
import { readFileSync } from 'fs';
import { join } from 'path';

import { HourglassChart } from '../src/hourglass-chart';
import { JsonDataProvider } from '../src/data';
import { gedcomToJson } from '../src/gedcom';
import {
  AccessibleItem,
  AccessibleModel,
  buildHourglassModel,
  relationTerm,
} from '../src/accessible-model';
import { FakeRenderer } from './fake_renderer';

(jsdomGlobal as any)(); // tslint:disable-line

// Fictional test tree: pedigree collapse, two marriages, QUAY values, a
// missing parent, unknown sex and a parentless sibling family.
const SAMPLE = join(__dirname, 'data/a11y-test.ged');

function model(startIndi: string): AccessibleModel {
  document.body.innerHTML = '<svg></svg>';
  const data = new JsonDataProvider(gedcomToJson(readFileSync(SAMPLE, 'utf8')));
  const info = new HourglassChart({
    data,
    startIndi,
    renderer: new FakeRenderer(),
    svgSelector: 'svg',
  }).render();
  return buildHourglassModel(info.layout!, data);
}

function find(m: AccessibleModel, pred: (i: AccessibleItem) => boolean) {
  return Array.from(m.items.values()).filter(pred);
}
const byIndi = (m: AccessibleModel, id: string) =>
  find(m, (i) => i.indiId === id);

describe('relationTerm', () => {
  const p = (sex: string | null) => ({ type: 'parent' as const, sex });
  const c = (sex: string | null) => ({ type: 'child' as const, sex });
  const s = (sex: string | null) => ({ type: 'spouse' as const, sex });
  it('names ancestors with side', () => {
    expect(relationTerm([p('M')])).toBe('father');
    expect(relationTerm([p('M'), p('F')])).toBe('paternal grandmother');
    expect(relationTerm([p('F'), p('M'), p('M')])).toBe('maternal great-grandfather');
  });
  it('names descendants and in-laws', () => {
    expect(relationTerm([c('F'), c(null)])).toBe('grandchild');
    expect(relationTerm([s('M')])).toBe('husband');
    expect(relationTerm([s('M'), p('F')])).toBe('mother-in-law');
    expect(relationTerm([c('F'), s('M')])).toBe('son-in-law');
    expect(relationTerm([c('F'), c('F'), s('M')])).toBe("granddaughter's husband");
  });
});

describe('buildHourglassModel', () => {
  it('roots the tree at the focal person with parents and marriages', () => {
    const m = model('I1');
    expect(m.root.indiId).toBe('I1');
    expect(m.root.label).toMatch(/^Ada Kowal, centre of chart. Born 12 March 1900 in Kraków/);
    expect(m.root.children.map((c) => c.kind)).toEqual([
      'person',
      'person',
      'marriage',
      'marriage',
    ]);
    expect(m.root.children[0].label).toMatch(/^Jan Kowal, father/);
    expect(m.root.children[1].label).toMatch(
      /^Maria Nowak, mother. Born about 1872 in Bochnia, Galicia, questionable evidence/,
    );
  });

  it('shows Ada once even though she is drawn once per marriage', () => {
    const m = model('I1');
    expect(byIndi(m, 'I1')).toHaveLength(1);
    const marriages = m.root.children.filter((c) => c.kind === 'marriage');
    expect(marriages[0].label).toBe(
      "Ada Kowal's marriage to Karl Weber, married 1920 in Wien, secondary evidence, 2 children",
    );
    expect(marriages[1].label).toMatch(/marriage to Henryk Zając.*2 children$/);
  });

  it('marks pedigree collapse and does not repeat ancestors', () => {
    const m = model('I1');
    const tomasz = byIndi(m, 'I8');
    expect(tomasz).toHaveLength(2);
    const [first, second] = tomasz;
    expect(first.relation).toBe('paternal great-grandfather');
    expect(second.duplicateOf).toBe(first.key);
    expect(second.label).toMatch(/also shown as paternal great-grandfather/);
    expect(second.children).toHaveLength(0);
    expect(first.otherOccurrences).toEqual([second.key]);
  });

  it('states missing parents within a family', () => {
    const m = model('I1');
    expect(find(m, (i) => i.kind === 'missing').map((i) => i.label)).toEqual([
      'Mother of Piotr Kowal: not recorded',
    ]);
  });

  it('names descendants and their relationships', () => {
    const m = model('I1');
    expect(byIndi(m, 'I18')[0].relation).toBe('granddaughter');
    expect(byIndi(m, 'I17')[0].relation).toBe('son-in-law');
    expect(byIndi(m, 'I15')[0].label).toMatch(/^Alex Zając, child\./);
    const lena = byIndi(m, 'I12')[0];
    expect(m.items.get(lena.relatives.mother!)!.indiId).toBe('I1');
    expect(m.items.get(lena.relatives.father!)!.indiId).toBe('I10');
    expect(lena.relatives.siblings.map((k) => m.items.get(k)!.indiId)).toEqual(['I13']);
  });

  it('notes parents that the chart does not show', () => {
    // Centred on Zofia, her son Jan's wife Maria has parents in the data
    // that the hourglass does not draw.
    const m = model('I5');
    expect(byIndi(m, 'I3')[0].description).toMatch(/Parents not shown/);
    // Karl Weber's parents' family has no recorded parents: nothing to show.
    expect(model('I1').items.size).toBeGreaterThan(0);
    expect(byIndi(model('I1'), 'I10')[0].description).not.toMatch(/Parents not shown/);
  });

  it('summarises the chart', () => {
    expect(model('I1').summary).toBe(
      'Hourglass chart centred on Ada Kowal. 9 ancestors, 5 descendants and 3 spouses or in-laws shown.',
    );
  });

  it('works for a person with no family', () => {
    const m = model('I13');
    expect(m.root.label).toMatch(/^Otto Weber, centre of chart/);
    expect(m.root.children.map((c) => c.relation)).toEqual(['father', 'mother']);
  });
});
