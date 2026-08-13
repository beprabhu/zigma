'use client';

// Prompt skills — the suite's shared prompt library, managed from Settings → Skills.
//
// A skill is a named .md prompt. Two kinds:
//   - Built-ins: shipped defaults (Compose's shelf composite, Cleanup's AI-edit packshot).
//     Read-only — duplicate one to tweak it.
//   - Custom: user-authored, persisted in this browser (skuc_skills).
// Products with a prompt surface a skill dropdown; picking one copies its content into the
// product's own prompt state, and the dropdown re-derives which skill matches by content —
// editing the prompt naturally flips the dropdown to "Custom", preset-style.

import { usePersistedState } from '@/hooks/use-persisted-state';
import { DEFAULT_PROMPT } from '@/lib/types';

export interface PromptSkill {
  id: string;
  /** File-style display name, e.g. "shelf-composite.md". */
  name: string;
  content: string;
  builtin?: boolean;
}

export const SKILLS_KEY = 'skuc_skills';
export const CUSTOM_SKILL_ID = 'custom';

/** Cleanup's AI-edit default — lived in the page file until skills made it shared. */
export const DEFAULT_AI_PROMPT = `Recreate this exact product as a clean e-commerce studio packshot.

PRODUCT FIDELITY (most important):
- Show EXACTLY what the reference shows, nothing more. If the product is unpackaged
  (loose produce, a bare fruit or vegetable), it stays unpackaged — NEVER add any
  packaging, wrapper, label, sticker, band, tag, or brand text that is not in the
  reference. Inventing a brand or label is the worst possible failure.
- If the reference DOES show packaging, keep it IDENTICAL: same shape, proportions,
  colors, label layout, logos, and all printed text exactly as shown. Do not redesign,
  restyle, translate, or invent any text or graphics on the pack.
- If part of the product is cut off in the reference, complete it plausibly and
  consistently with the visible portion (e.g. the base of a jar or bottle).

SCENE:
- Pure white seamless background (#FFFFFF), professional studio product photography.
- Soft, even, diffused lighting; a subtle natural contact shadow under the product only.
- Product centered, fully visible, front label facing camera, straight-on angle,
  occupying about 80% of the frame with even margins on all sides.

REMOVE EVERYTHING ELSE:
- No props, no hands or people, no surfaces or tables, no plates, bowls or serving
  dishes (unless the dish itself IS the product), no plants, no decorative items.
- No added text, watermarks, badges, banners, or graphic overlays on the image.
- Show the product plus at most ONE cut/open piece beside it — never scattered pieces
  or repeated duplicates. Shrunk to a 40x40 thumbnail, the image must still read
  instantly as this product.`;

export const BUILTIN_SKILLS: PromptSkill[] = [
  { id: 'builtin-shelf', name: 'shelf-composite.md', content: DEFAULT_PROMPT, builtin: true },
  { id: 'builtin-packshot', name: 'studio-packshot.md', content: DEFAULT_AI_PROMPT, builtin: true },
];

/** Custom skills live in storage; the full list is built-ins first, then custom. */
export function useSkills() {
  const [custom, setCustom] = usePersistedState<PromptSkill[]>(SKILLS_KEY, []);
  const safeCustom = Array.isArray(custom) ? custom.filter((s) => s && typeof s.id === 'string') : [];
  return {
    skills: [...BUILTIN_SKILLS, ...safeCustom],
    custom: safeCustom,
    setCustom,
  };
}

/** Content-derived selection, preset-style: which skill does this prompt currently equal? */
export function matchSkill(content: string, skills: PromptSkill[]): string {
  const trimmed = content.trim();
  return skills.find((s) => s.content.trim() === trimmed)?.id ?? CUSTOM_SKILL_ID;
}

export function newSkillId(): string {
  return `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
