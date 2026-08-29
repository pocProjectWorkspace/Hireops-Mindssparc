import { LegalArticle } from "@/components/LegalArticle";
import { PlatformFooter } from "@/components/PlatformFooter";
import { TERMS_OF_USE } from "@/lib/legal-copy";

export const metadata = { title: "Terms of Use · HireOps" };

export default function TermsPage() {
  return (
    <div className="flex min-h-screen flex-col bg-neutral-50">
      <LegalArticle doc={TERMS_OF_USE} />
      <PlatformFooter />
    </div>
  );
}
