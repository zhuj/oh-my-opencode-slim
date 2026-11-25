import { describe, expect, test } from 'bun:test';
import {
  PROMPT_TEMPLATE_MARKER,
  PromptTemplateError,
  renderPromptTemplate,
} from './prompt-template';

const SECTIONS = {
  intent_gate: 'INTENT_GATE',
  agents: 'AGENT_SECTION',
  orchestration: 'ORCHESTRATION_SECTION',
} as const;

describe('renderPromptTemplate', () => {
  test('leaves an unmarked prompt unchanged', () => {
    const prompt = 'literal {{slim.section.intent_gate}}';

    const rendered = renderPromptTemplate(prompt, SECTIONS, 'orchestrator.md');

    expect(rendered).toBe(prompt);
  });

  test('renders marked known sections in one pass', () => {
    const prompt = [
      PROMPT_TEMPLATE_MARKER,
      'before {{slim.section.intent_gate}} after {{slim.section.agents}}',
    ].join('\n');

    const rendered = renderPromptTemplate(prompt, SECTIONS, 'orchestrator.md');

    expect(rendered).toContain('INTENT_GATE');
    expect(rendered).toContain('AGENT_SECTION');
    expect(rendered).not.toContain('{{slim.section.');
  });

  test('renders high-level orchestration sections', () => {
    const prompt = [
      PROMPT_TEMPLATE_MARKER,
      '{{slim.section.orchestration}}',
    ].join('\n');

    expect(renderPromptTemplate(prompt, SECTIONS, 'orchestrator.md')).toContain(
      'ORCHESTRATION_SECTION',
    );
  });

  test('allows an escaped placeholder to remain literal', () => {
    const prompt = [
      PROMPT_TEMPLATE_MARKER,
      String.raw`literal \{{slim.section.intent_gate}}`,
    ].join('\n');

    const rendered = renderPromptTemplate(prompt, SECTIONS, 'orchestrator.md');

    expect(rendered).toContain('{{slim.section.intent_gate}}');
    expect(rendered).not.toContain('INTENT_GATE');
  });

  test('does not recursively render inserted section content', () => {
    const sections = {
      intent_gate: '{{slim.section.agents}}',
      agents: 'AGENT_SECTION',
    } as const;

    const rendered = renderPromptTemplate(
      `${PROMPT_TEMPLATE_MARKER}\n{{slim.section.intent_gate}}`,
      sections,
      'orchestrator.md',
    );

    expect(rendered).toContain('{{slim.section.agents}}');
  });

  test('reports unknown placeholders with source context', () => {
    const prompt = `${PROMPT_TEMPLATE_MARKER}\n{{slim.section.unknown}}`;

    expect(() =>
      renderPromptTemplate(prompt, SECTIONS, 'orchestrator.md'),
    ).toThrow(PromptTemplateError);
    expect(() =>
      renderPromptTemplate(prompt, SECTIONS, 'orchestrator.md'),
    ).toThrow('orchestrator.md');
  });

  test('does not resolve inherited section properties', () => {
    const sections = Object.create({ constructor: 'INHERITED' }) as Record<
      string,
      string
    >;
    sections.intent_gate = 'INTENT_GATE';
    const prompt = `${PROMPT_TEMPLATE_MARKER}\n{{slim.section.constructor}}`;

    expect(() =>
      renderPromptTemplate(prompt, sections, 'orchestrator.md'),
    ).toThrow(PromptTemplateError);
  });
});
