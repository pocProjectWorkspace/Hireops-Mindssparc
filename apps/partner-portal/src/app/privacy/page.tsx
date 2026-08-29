import { LegalArticle } from "@/components/LegalArticle";
import { PlatformFooter } from "@/components/PlatformFooter";
import { PRIVACY_POLICY } from "@/lib/legal-copy";

export const metadata = { title: "Privacy Policy · HireOps" };

export default function PrivacyPage() {
  return (
    <div className="flex min-h-screen flex-col bg-neutral-50">
      <LegalArticle doc={PRIVACY_POLICY} />
      <PlatformFooter />
    </div>
  );
}
