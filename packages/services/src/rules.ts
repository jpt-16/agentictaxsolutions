import { eq } from "drizzle-orm";
import { assertCan, parseRuleParams, VALIDATION_RULES } from "@taxops/core";
import { recordAudit, ruleSettings } from "@taxops/db";
import { z } from "zod";
import { auditActorOf, NotFoundError, scoped, type ServiceContext } from "./context";

export interface RuleView { id: string; name: string; description: string; severity: string; enabled: boolean; params: Record<string, string>; defaults: Record<string, string>; customized: boolean }

/** The catalog merged with this tenant's settings. Anyone who can see AI output may read it. */
export async function listRules(ctx: ServiceContext): Promise<RuleView[]> {
  assertCan(ctx.session.role, "proposal.read");
  return scoped(ctx, async (tx) => {
    const rows = await tx.select().from(ruleSettings);
    return VALIDATION_RULES.map((r) => {
      const s = rows.find((x) => x.ruleId === r.id);
      return {
        id: r.id, name: r.name, description: r.description, severity: r.severity, defaults: r.params,
        enabled: s?.enabled ?? true, params: { ...r.params, ...((s?.params as Record<string, string> | undefined) ?? {}) }, customized: !!s,
      };
    });
  });
}

const updateSchema = z.object({ enabled: z.boolean(), params: z.record(z.string(), z.string()).default({}) });

/** Takes effect the next time validation runs. The database independently refuses anyone who is not a manager or admin. */
export async function updateRule(ctx: ServiceContext, ruleId: string, raw: unknown) {
  assertCan(ctx.session.role, "rules.manage");
  const rule = VALIDATION_RULES.find((r) => r.id === ruleId);
  if (!rule) throw new NotFoundError("Rule");
  const input = updateSchema.parse(raw);
  const params = parseRuleParams(ruleId, input.params);
  return scoped(ctx, async (tx) => {
    const [before] = await tx.select().from(ruleSettings).where(eq(ruleSettings.ruleId, ruleId));
    await tx.insert(ruleSettings).values({ tenantId: ctx.session.tenantId, ruleId, enabled: input.enabled, params, updatedBy: ctx.session.userId })
      .onConflictDoUpdate({ target: [ruleSettings.tenantId, ruleSettings.ruleId], set: { enabled: input.enabled, params } });
    await recordAudit(tx, {
      tenantId: ctx.session.tenantId, actor: auditActorOf(ctx), action: "rule.updated", entityType: "validation_rule", entityId: null,
      summary: `${input.enabled ? "Enabled" : "Disabled"} validation rule "${rule.name}"${Object.keys(params).length ? ` (${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(", ")})` : ""}`,
      before: before ? { enabled: before.enabled, params: before.params } : { enabled: true, params: rule.params }, after: { rule: ruleId, enabled: input.enabled, params },
    });
  });
}
