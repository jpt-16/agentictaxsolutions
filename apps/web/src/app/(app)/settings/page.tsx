import { notFound } from "next/navigation";
import { can } from "@taxops/core";
import { getTenantSettings, listRules, listUsers } from "@taxops/services";
import { requireContext } from "@/lib/auth";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { GovernanceForm } from "./governance";
import { RuleRow } from "./rule-row";
import { UsersTable } from "./users";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const ctx = await requireContext();
  const role = ctx.session.role;
  const isAdmin = can(role, "tenant.admin"), canRules = can(role, "rules.manage");
  if (!isAdmin && !canRules) notFound();
  const [tenant, people, rules] = await Promise.all([
    isAdmin ? getTenantSettings(ctx) : null, isAdmin ? listUsers(ctx) : null, canRules ? listRules(ctx) : null,
  ]);
  return (
    <>
      <PageHeader title="Settings" subtitle="How your organization’s data, people and validation are handled. Every change is recorded in the audit history." />
      <div className="space-y-5">
        {tenant && (
          <Card>
            <CardHeader title="Data & AI governance" subtitle="You decide whether AI agents work on your files, and whether anything may leave this system." />
            <GovernanceForm ai={tenant.aiExtractionEnabled} external={tenant.externalLlmEnabled} />
          </Card>
        )}
        {people && (
          <Card>
            <CardHeader title="People" subtitle={`${people.users.filter((u) => u.isActive).length} active · roles control what each person can see and do`} />
            <UsersTable users={people.users} depts={people.departments} ents={people.entities} selfId={ctx.session.userId} />
          </Card>
        )}
        {rules && (
          <Card>
            <CardHeader title="Validation rules" subtitle="Deterministic checks run on every accepted trial balance. Turn off rules that do not fit your chart, or tune their thresholds." />
            <ul className="divide-y divide-line">{rules.map((r) => <RuleRow key={r.id} {...r} editable />)}</ul>
          </Card>
        )}
      </div>
    </>
  );
}
