/**
 * 深度学习实验 preset composition tests.
 *
 * `packages/preset-lab/` is the deployable unit: the directory copied under
 * `$DSH_HOME/.agent-presets/dlab/`. It is a COMPLETE agent composition —
 * `standard` plus two additions — and these assertions keep it honest:
 *
 *  - every baseline coding row of `standard` is still present;
 *  - the lab tool row references the REAL host export (an early version
 *    pointed at a phantom '@dsh-lab/lab-tool-set' that resolved to nothing);
 *  - the dlab usage skill travels inside the preset and mounts via
 *    `customSkillDirs`, so it resolves wherever the preset is installed;
 *  - the DL operating protocol hands directional judgement to the
 *    `subagent_sol` advisor and keeps every ordinary child on the parent's
 *    own model route;
 *  - preset.yml carries picker metadata.
 *
 * The composition itself is mount-validated by DSH
 * (`AgentPresets.standingKeyFor`); this suite only guards the content.
 */

import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const DIR = new URL('../../packages/preset-lab/', import.meta.url)

const composition = readFileSync(new URL('agent.cordis.yml', DIR), 'utf8')
const metadata = readFileSync(new URL('preset.yml', DIR), 'utf8')

describe('深度学习实验 agent preset composition', () => {
  it('is standard-plus-dlab: every baseline coding row is present', () => {
    for (const row of [
      "'@deepseek-ai/dsh-persona'",
      "'@deepseek-ai/dsh-tool-bash'",
      "'@deepseek-ai/dsh-tool-fs'",
      "'@deepseek-ai/dsh-tool-jobs'",
      "'@deepseek-ai/dsh-skill-filesystem'",
      "'@deepseek-ai/dsh-tool-skill'",
      "'@deepseek-ai/dsh-tool-subagent'",
      "'@deepseek-ai/dsh-tool-web'",
      "'@deepseek-ai/dsh-tool-present'",
      "'@deepseek-ai/dsh-tool-todo'",
    ]) {
      expect(composition).toContain(row)
    }
  })

  it('grants the lab_* tools through the REAL host export', () => {
    expect(composition).toContain("name: '@dsh-lab/host/tools'")
    // the phantom row name from the v0.1 skeleton resolved to nothing
    expect(composition).not.toContain('lab-tool-set')
  })

  it('carries the dlab skill and mounts it from the preset directory', () => {
    expect(composition).toContain("new URL('skills/', baseUrl)")
    const skill = readFileSync(new URL('skills/dlab/SKILL.md', DIR), 'utf8')
    expect(skill).toMatch(/^---\nname: dlab\n/)
    expect(skill).toContain('lab_start_run')
    expect(skill).toContain('card-agnostic')
  })

  it('carries the DL operating protocol in the persona suffix', () => {
    expect(composition).toContain('深度学习实验规程')
    expect(composition).toContain('subagent_sol')
    // the protocol covers delegated children too, so it lives in the suffix
    expect(composition).toMatch(/prefix: >-\n\s+You are a deep-learning experiment agent/)
  })

  it('keeps ordinary children on the parent route (no model selection)', () => {
    expect(composition).toContain('modelSelectionSettings: false')
  })

  it('pins the directional advisor to the Sol route, as a durable child', () => {
    const advisor = composition.slice(composition.indexOf('- id: tool-subagent-sol'))
    expect(advisor).toContain('toolName: subagent_sol')
    expect(advisor).toContain('backgroundMode: continuable')
    expect(advisor).toContain('maxDepth: 1')
    expect(advisor).toMatch(/agentOptions:\n\s+provider: openai-codex\n\s+model: gpt-5\.6-sol\n\s+reasoningEffort: max/)
  })

  it('raises the background-wake budget for a run/wake chain', () => {
    expect(composition).toMatch(/maxConsecutiveWakes: 20/)
  })

  it('ships picker metadata', () => {
    expect(metadata).toMatch(/^name: 深度学习实验$/m)
    expect(metadata).toMatch(/^description: .+/m)
    expect(metadata).toMatch(/^order: \d+$/m)
    // the preset directory itself is the deployable unit
    expect(existsSync(new URL('agent.cordis.yml', DIR))).toBe(true)
  })
})
