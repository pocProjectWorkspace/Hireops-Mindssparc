/**
 * RO-02 — the shape of a wizard "Quick start" role template. The templates
 * themselves come only from the tenant's JD library (jd_templates, admin:
 * /jd-library). The platform ships no built-in roles: the old hard-coded set
 * was six tech roles, wrong for any tenant that doesn't hire engineers.
 */

import type { RequisitionLocationType, RequisitionSkillInput } from "@hireops/api-types";

export interface RoleTemplateSkill extends RequisitionSkillInput {
  category: string;
}

export interface RoleTemplate {
  id: string;
  /** Short chip label. */
  label: string;
  title: string;
  seniority: string;
  locationType: RequisitionLocationType;
  /** Annual INR budget band (min/max), shown as a hint; fully editable. */
  budgetMinInr: number;
  budgetMaxInr: number;
  /** Optional steer text prefilled into the JD generator's extra-context box. */
  extraContext: string;
  skills: RoleTemplateSkill[];
}
