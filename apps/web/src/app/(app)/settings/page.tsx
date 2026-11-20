import { notFound } from "next/navigation";
import { can } from "@taxops/core";
import { listRules } from "@taxops/services";
import { requireContext } from "@/lib/auth";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { RuleRow } from "./rule-row";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const ctx = await requireContext();
  if (!can(ctx.session.role, "rules.manage")) notFound();
  const rules = await listRules(ctx);
  return (
    <>
      <PageHeader title="Settings" subtitle="How your organization’s validation behaves. Changes are recorded in the audit history." />
      <Card>
        <CardHeader title="Validation rules" subtitle="Deterministic checks run on every accepted trial balance. Turn off rules that do not fit your chart, or tune their thresholds." />
        <ul className="divide-y divide-line">
          {rules.map((r) => <RuleRow key={r.id} {...r} editable />)}
        </ul>
      </Card>
    </>
  );
}
