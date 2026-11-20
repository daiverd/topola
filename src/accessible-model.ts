/**
 * [Experimental] Accessible model of a rendered chart.
 *
 * Builds a person-level tree, rooted at the chart's focal person, from the
 * hierarchies a chart was actually laid out from. The model is plain data:
 * hosts render it as ARIA (an HTML tree, or attributes on the SVG) and use it
 * for keyboard navigation and announcements. Every item records which drawn
 * node it corresponds to (`nodeId`, matching `data-node-id` on `g.node`), so
 * hosts can move a focus indicator to it.
 *
 * Strings are English only for now.
 */
import { HierarchyPointNode } from 'd3-hierarchy';
import { DataProvider, HourglassLayout, TreeNode } from './api';
import {
  Date as TopolaDate,
  DateOrRange,
  FamDetails,
  IndiDetails,
} from './data';
import { DUMMY_ROOT_NODE_ID } from './descendant-chart';

export type AccessibleItemKind = 'person' | 'marriage' | 'missing';

export interface AccessibleRelatives {
  father?: string | undefined;
  mother?: string | undefined;
  spouses: string[];
  children: string[];
  siblings: string[];
}

export interface AccessibleItem {
  /** Unique key within the model. */
  key: string;
  kind: AccessibleItemKind;
  /** Accessible name. */
  label: string;
  /** Secondary information (occupation, notes on what is not shown, ID). */
  description: string;
  indiId?: string | undefined;
  famId?: string | undefined;
  /** ID of the drawn tree node (`data-node-id` on `g.node`). */
  nodeId?: string | undefined;
  /** Absolute generation number, as used by the chart's colors and IndiInfo. */
  generation: number;
  parent?: AccessibleItem | undefined;
  children: AccessibleItem[];
  /** Relationship to the focal person, e.g. "paternal grandmother". */
  relation: string;
  /** Relationship spelled out as a path, e.g. "Ada Kowal's father's mother". */
  path: string;
  /** Key of the first occurrence, if this person is shown more than once. */
  duplicateOf?: string | undefined;
  /** Keys of later occurrences of this person. */
  otherOccurrences: string[];
  /** Keys of related items in the model, by relationship. */
  relatives: AccessibleRelatives;
}

export interface AccessibleModel {
  root: AccessibleItem;
  items: Map<string, AccessibleItem>;
  /** One-sentence overview, announced on entry and after re-centring. */
  summary: string;
}

type StepType = 'parent' | 'child' | 'spouse';
interface Step {
  type: StepType;
  sex: string | null;
}

function sexed(sex: string | null, m: string, f: string, other: string) {
  return sex === 'M' ? m : sex === 'F' ? f : other;
}

function singleTerm(step: Step): string {
  switch (step.type) {
    case 'parent':
      return sexed(step.sex, 'father', 'mother', 'parent');
    case 'child':
      return sexed(step.sex, 'son', 'daughter', 'child');
    case 'spouse':
      return sexed(step.sex, 'husband', 'wife', 'spouse');
  }
}

function ancestorTerm(steps: Step[], withSide: boolean): string {
  const n = steps.length;
  const last = steps[n - 1].sex;
  if (n === 1) {
    return sexed(last, 'father', 'mother', 'parent');
  }
  const base =
    'great-'.repeat(n - 2) +
    'grand' +
    sexed(last, 'father', 'mother', 'parent');
  const side = withSide
    ? sexed(steps[0].sex, 'paternal ', 'maternal ', '')
    : '';
  return side + base;
}

function descendantTerm(steps: Step[]): string {
  const n = steps.length;
  const last = steps[n - 1].sex;
  if (n === 1) {
    return sexed(last, 'son', 'daughter', 'child');
  }
  return (
    'great-'.repeat(n - 2) + 'grand' + sexed(last, 'son', 'daughter', 'child')
  );
}

/** Returns an English kinship term for a path of steps from the focal person. */
export function relationTerm(steps: Step[]): string {
  if (!steps.length) {
    return '';
  }
  const all = (type: StepType, list = steps) =>
    list.every((s) => s.type === type);
  if (all('parent')) {
    return ancestorTerm(steps, true);
  }
  if (all('child')) {
    return descendantTerm(steps);
  }
  if (steps.length === 1) {
    return singleTerm(steps[0]);
  }
  const head = steps[0];
  const rest = steps.slice(1);
  if (head.type === 'spouse' && all('parent', rest)) {
    if (rest.length === 1) {
      return sexed(
        rest[0].sex,
        'father-in-law',
        'mother-in-law',
        'parent-in-law',
      );
    }
    return `${singleTerm(head)}'s ${ancestorTerm(rest, true)}`;
  }
  const last = steps[steps.length - 1];
  const init = steps.slice(0, -1);
  if (last.type === 'spouse' && all('child', init)) {
    if (init.length === 1) {
      return sexed(last.sex, 'son-in-law', 'daughter-in-law', 'child-in-law');
    }
    return `${descendantTerm(init)}'s ${singleTerm(last)}`;
  }
  return steps.map(singleTerm).join("'s ");
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const QUALIFIERS = new Map([
  ['abt', 'about'],
  ['cal', 'calculated'],
  ['est', 'estimated'],
]);

function formatDate(date: TopolaDate): string {
  const parts: string[] = [];
  if (date.day) parts.push(String(date.day));
  if (date.month) parts.push(MONTHS[date.month - 1]);
  if (date.year) parts.push(String(date.year));
  if (!parts.length) {
    return date.text || '';
  }
  const qualifier = QUALIFIERS.get(date.qualifier || '');
  return (qualifier ? qualifier + ' ' : '') + parts.join(' ');
}

/** Formats a date or range in words, e.g. "about 1872", "between 1840 and 1845". */
export function formatDateInWords(
  date: DateOrRange | null | undefined,
): string {
  if (!date) return '';
  if (date.date) return formatDate(date.date);
  const from = date.dateRange?.from && formatDate(date.dateRange.from);
  const to = date.dateRange?.to && formatDate(date.dateRange.to);
  if (from && to) return `between ${from} and ${to}`;
  if (from) return `after ${from}`;
  if (to) return `before ${to}`;
  return '';
}

/** Words for GEDCOM QUAY values that the chart draws as dashed or faded. */
function evidenceWords(confidence: number | null | undefined): string {
  switch (confidence) {
    case 0:
      return 'unreliable evidence';
    case 1:
      return 'questionable evidence';
    case 2:
      return 'secondary evidence';
    default:
      return '';
  }
}

function eventPhrase(
  verb: string,
  date: DateOrRange | null | undefined,
  place: string | null | undefined,
  confidence: number | null | undefined,
): string {
  const dateText = formatDateInWords(date);
  if (!dateText && !place) return '';
  let text = verb;
  if (dateText) text += ' ' + dateText;
  if (place) text += ' in ' + place;
  const evidence = evidenceWords(confidence);
  if (evidence) text += ', ' + evidence;
  return text;
}

type Node = HierarchyPointNode<TreeNode>;

/**
 * Builds the accessible model of an hourglass chart from the layout returned in
 * ChartInfo.layout.
 */
export function buildHourglassModel(
  layout: HourglassLayout,
  data: DataProvider<IndiDetails, FamDetails>,
): AccessibleModel {
  const items = new Map<string, AccessibleItem>();
  const firstOccurrence = new Map<string, string>();
  const ancestorsById = new Map(layout.ancestors.map((n) => [n.id!, n]));
  const descendants = layout.descendants;
  const ancestorRoot = layout.ancestors[0];
  const rootNode = descendants[0];
  const rootId = rootNode.data.indi!.id;

  const indi = (id: string) => data.getIndi(id);
  const sexOf = (id: string) => indi(id)?.getSex() || null;
  const nameOf = (id: string) => {
    const i = indi(id);
    const name = [i?.getFirstName(), i?.getLastName()]
      .filter((x) => !!x)
      .join(' ');
    return name || 'Unknown name';
  };
  const rootName = nameOf(rootId);

  function addItem(item: AccessibleItem, parent?: AccessibleItem) {
    let key = item.key;
    for (let i = 2; items.has(key); i++) key = `${item.key}#${i}`;
    item.key = key;
    item.parent = parent;
    parent?.children.push(item);
    items.set(key, item);
    return item;
  }

  function person(
    indiId: string,
    nodeId: string,
    generation: number,
    steps: Step[],
    parent?: AccessibleItem,
  ): AccessibleItem {
    const first = firstOccurrence.get(indiId);
    const item = addItem(
      {
        key: `p:${nodeId}:${indiId}`,
        kind: 'person',
        label: '',
        description: '',
        indiId,
        nodeId,
        generation,
        children: [],
        relation: relationTerm(steps),
        path: steps.length
          ? `${rootName}'s ${steps.map(singleTerm).join("'s ")}`
          : `${rootName}, the centre of the chart`,
        duplicateOf: first,
        otherOccurrences: [],
        relatives: { spouses: [], children: [], siblings: [] },
      },
      parent,
    );
    if (first) {
      items.get(first)!.otherOccurrences.push(item.key);
    } else {
      firstOccurrence.set(indiId, item.key);
    }
    return item;
  }

  function addAncestors(
    child: AccessibleItem,
    parentsNodeId: string | undefined,
    childSteps: Step[],
  ) {
    const node = parentsNodeId && ancestorsById.get(parentsNodeId);
    if (!node) return;
    const slots: Array<
      ['father' | 'mother', string | undefined, string | undefined]
    > = [
      ['father', node.data.indi?.id, node.data.indiParentNodeId],
      ['mother', node.data.spouse?.id, node.data.spouseParentNodeId],
    ];
    const parentItems: AccessibleItem[] = [];
    for (const [slot, id, grandparentsNodeId] of slots) {
      if (!id) {
        addItem(
          {
            key: `x:${node.id}:${slot}`,
            kind: 'missing',
            label: `${slot === 'father' ? 'Father' : 'Mother'} of ${nameOf(
              child.indiId!,
            )}: not recorded`,
            description: '',
            nodeId: node.id,
            generation: node.data.generation!,
            children: [],
            relation: '',
            path: '',
            otherOccurrences: [],
            relatives: { spouses: [], children: [], siblings: [] },
          },
          child,
        );
        continue;
      }
      const steps: Step[] = [...childSteps, { type: 'parent', sex: sexOf(id) }];
      const item = person(id, node.id!, node.data.generation!, steps, child);
      item.relatives.children.push(child.key);
      child.relatives[slot] = item.key;
      parentItems.push(item);
      if (!item.duplicateOf) {
        addAncestors(item, grandparentsNodeId, steps);
      }
    }
    if (parentItems.length === 2) {
      parentItems[0].relatives.spouses.push(parentItems[1].key);
      parentItems[1].relatives.spouses.push(parentItems[0].key);
    }
  }

  function addMarriage(
    personItem: AccessibleItem,
    node: Node,
    personSteps: Step[],
    spouseParentsNodeId?: string,
  ) {
    const famId = node.data.family!.id;
    const fam = data.getFam(famId);
    const marriage = addItem(
      {
        key: `m:${node.id}`,
        kind: 'marriage',
        label: '',
        description: '',
        famId,
        nodeId: node.id,
        generation: node.data.generation!,
        children: [],
        relation: '',
        path: '',
        otherOccurrences: [],
        relatives: { spouses: [], children: [], siblings: [] },
      },
      personItem,
    );

    let spouseItem: AccessibleItem | undefined;
    const spouseId = node.data.spouse?.id;
    if (spouseId) {
      const steps: Step[] = [
        ...personSteps,
        { type: 'spouse', sex: sexOf(spouseId) },
      ];
      spouseItem = person(
        spouseId,
        node.id!,
        node.data.generation!,
        steps,
        marriage,
      );
      spouseItem.relatives.spouses.push(personItem.key);
      personItem.relatives.spouses.push(spouseItem.key);
      if (!spouseItem.duplicateOf) {
        addAncestors(spouseItem, spouseParentsNodeId, steps);
      }
    }

    // Children are drawn as the nodes whose parent is this family node. A
    // child with several marriages has one node per marriage.
    const childNodes = descendants.filter((n) => n.parent === node);
    const childIds = Array.from(
      new Set(childNodes.map((n) => n.data.indi!.id)),
    );
    const parents = [personItem, spouseItem].filter(
      (x): x is AccessibleItem => !!x,
    );
    const father = parents.find((p) => sexOf(p.indiId!) === 'M') || parents[0];
    const mother = parents.find((p) => p !== father);
    const childItems = childIds.map((childId) => {
      const nodes = childNodes.filter((n) => n.data.indi!.id === childId);
      const primary = nodes.find((n) => !n.data.additionalMarriage) || nodes[0];
      const steps: Step[] = [
        ...personSteps,
        { type: 'child', sex: sexOf(childId) },
      ];
      const item = person(
        childId,
        primary.id!,
        primary.data.generation!,
        steps,
        marriage,
      );
      item.relatives.father = father?.key;
      item.relatives.mother = mother?.key;
      if (!item.duplicateOf) {
        nodes
          .filter((n) => !!n.data.family)
          .forEach((n) => addMarriage(item, n, steps));
      }
      return item;
    });
    const childKeys = childItems.map((c) => c.key);
    childItems.forEach((c) => {
      c.relatives.siblings = childKeys.filter((k) => k !== c.key);
    });
    parents.forEach((p) => p.relatives.children.push(...childKeys));

    const parts = [
      spouseId
        ? `${nameOf(personItem.indiId!)}'s marriage to ${nameOf(spouseId)}`
        : `${nameOf(personItem.indiId!)}'s family, spouse not recorded`,
    ];
    const event = eventPhrase(
      'married',
      fam?.getMarriageDate(),
      fam?.getMarriagePlace(),
      fam?.getMarriageConfidence?.(),
    );
    if (event) parts.push(event);
    parts.push(
      childIds.length === 0
        ? 'no children'
        : childIds.length === 1
          ? '1 child'
          : `${childIds.length} children`,
    );
    marriage.label = parts.join(', ');
  }

  // Root person and their parents.
  const root = person(rootId, rootNode.id!, rootNode.data.generation!, []);
  addAncestors(root, ancestorRoot.data.indiParentNodeId, []);

  // Root marriages: the start node, plus additional marriages that were laid
  // out under the (removed) dummy root node.
  const rootMarriages = [
    rootNode,
    ...descendants.filter(
      (n) => n.data.additionalMarriage && n.parent?.id === DUMMY_ROOT_NODE_ID,
    ),
  ].filter((n) => !!n.data.family);
  rootMarriages.forEach((node, i) =>
    addMarriage(
      root,
      node,
      [],
      i === 0 ? ancestorRoot.data.spouseParentNodeId : undefined,
    ),
  );

  // Labels and descriptions, now that relationships are known.
  items.forEach((item) => {
    if (item.kind !== 'person') return;
    const i = indi(item.indiId!)!;
    const relation = item.relation || 'centre of chart';
    let label = `${nameOf(item.indiId!)}, ${relation}`;
    if (item.duplicateOf) {
      const first = items.get(item.duplicateOf)!;
      // If both places have the same kinship term (for example two
      // great-grandmothers on the same side), the term can't tell them
      // apart, so spell out the path instead.
      const other =
        first.relation && first.relation === item.relation
          ? first.path
          : first.relation || 'centre of chart';
      label += `, also shown as ${other}`;
    }
    const facts = [
      eventPhrase(
        'born',
        i.getBirthDate(),
        i.getBirthPlace(),
        i.getBirthConfidence?.(),
      ),
      eventPhrase(
        'died',
        i.getDeathDate(),
        i.getDeathPlace(),
        i.getDeathConfidence?.(),
      ),
    ].filter((x) => !!x);
    if (!facts[1] && i.isConfirmedDeath()) facts.push('deceased');
    if (facts.length) {
      const text = facts.join('; ');
      label += '. ' + text.charAt(0).toUpperCase() + text.slice(1);
    }
    item.label = label;

    const description: string[] = [];
    (i.getOccupations?.() || []).forEach((o) =>
      description.push(`Occupation: ${o}`),
    );
    (i.getTitles?.() || []).forEach((t) => description.push(`Title: ${t}`));
    const linkEvidence = evidenceWords(i.getParentLinkConfidence?.());
    const parentsShown =
      !!(item.relatives.father || item.relatives.mother) ||
      item.children.some((c) => c.kind === 'missing');
    if (item.duplicateOf) {
      description.push('Press G to go to where this person was first shown');
    } else if (item.otherOccurrences.length) {
      description.push(
        `Shown ${item.otherOccurrences.length + 1} times in this chart. Press G to go to the next occurrence`,
      );
    }
    if (parentsShown && linkEvidence) {
      description.push(`Link to parents: ${linkEvidence}`);
    }
    const famc = i.getFamilyAsChild();
    const parentsFam = famc ? data.getFam(famc) : null;
    const hasParents = !!(parentsFam?.getFather() || parentsFam?.getMother());
    if (!parentsShown && !item.duplicateOf && hasParents) {
      description.push(
        'Parents not shown in this chart. Press Enter to centre the chart on this person',
      );
    }
    item.description = description.join('. ');
  });

  const people = Array.from(items.values()).filter(
    (i) => i.kind === 'person' && !i.duplicateOf,
  );
  const count = (pred: (i: AccessibleItem) => boolean) =>
    people.filter(pred).length;
  const isAncestor = (i: AccessibleItem) =>
    i !== root &&
    /^(paternal |maternal )?((great-)*grand)?(father|mother|parent)$/.test(
      i.relation,
    );
  const isDescendant = (i: AccessibleItem) =>
    /^((great-)*grand)?(son|daughter|child)$/.test(i.relation);
  const ancestors = count(isAncestor);
  const descendantCount = count(isDescendant);
  const others = people.length - 1 - ancestors - descendantCount;
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? '' : 's'}`;
  const summary =
    `Hourglass chart centred on ${rootName}. ` +
    `${plural(ancestors, 'ancestor')}, ${plural(descendantCount, 'descendant')}` +
    (others
      ? ` and ${plural(others, 'spouse')} or in-law${others === 1 ? '' : 's'}`
      : '') +
    ' shown.';

  return { root, items, summary };
}
