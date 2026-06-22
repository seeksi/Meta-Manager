// Module 5 — AI copywriting. Structured output via AI SDK + Vercel AI Gateway.
// docs/ARCHITECTURE.md (AI copy), docs/PRODUCT_SPEC.md §5. Schema-validated, not free-form.
import { generateObject } from "ai";
import { z } from "zod";

// Meta recommended character limits (truncation thresholds in feed).
export const META_LIMITS = { headline: 40, primaryText: 125, description: 30 } as const;

const VariantSchema = z.object({
  headline: z.string().describe(`<= ${META_LIMITS.headline} chars`),
  primaryText: z.string().describe(`<= ${META_LIMITS.primaryText} chars`),
  description: z.string().describe(`<= ${META_LIMITS.description} chars`),
});
const CopySchema = z.object({ variants: z.array(VariantSchema) });

export interface CopyBrief {
  product: string;
  audience?: string;
  brandVoice?: string;
  count?: number;
}

export interface CopyVariant {
  headline: string;
  primaryText: string;
  description: string;
  violations: string[]; // fields exceeding Meta limits
}

function violationsOf(v: z.infer<typeof VariantSchema>): string[] {
  const out: string[] = [];
  for (const [field, limit] of Object.entries(META_LIMITS)) {
    const value = v[field as keyof typeof META_LIMITS];
    if (value.length > limit) out.push(`${field} ${value.length}/${limit}`);
  }
  return out;
}

export async function generateAdCopy(brief: CopyBrief): Promise<CopyVariant[]> {
  const count = Math.min(Math.max(brief.count ?? 3, 1), 6);
  const { object } = await generateObject({
    // String model id routes through Vercel AI Gateway (AI_GATEWAY_API_KEY).
    model: process.env.COPY_MODEL ?? "anthropic/claude-sonnet-4-6",
    schema: CopySchema,
    system: [
      "You are a senior direct-response copywriter for Meta (Facebook/Instagram) ads.",
      brief.brandVoice ? `Brand voice: ${brief.brandVoice}.` : "Use a clear, benefit-led voice.",
      `Stay within Meta limits: headline <= ${META_LIMITS.headline} chars, primary text <= ${META_LIMITS.primaryText} chars, description <= ${META_LIMITS.description} chars.`,
      "No unsupported claims, no banned categories, no fabricated stats.",
    ].join(" "),
    prompt: [
      `Write ${count} distinct ad copy variants for: ${brief.product}.`,
      brief.audience ? `Target audience: ${brief.audience}.` : "",
      "Vary the angle across variants (e.g. benefit, social proof, urgency, curiosity).",
    ].filter(Boolean).join("\n"),
  });

  return object.variants.slice(0, count).map((v) => ({ ...v, violations: violationsOf(v) }));
}
