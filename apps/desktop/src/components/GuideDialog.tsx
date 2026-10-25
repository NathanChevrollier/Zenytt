// Fenêtre ouverte par le « ? » d'une page : uniquement la fiche de cette page, sans quitter l'écran.
import { BookOpen } from "lucide-react";
import { guideOf } from "../lib/guides";
import { useApp, useAppPick } from "../lib/store";
import { Button, Modal } from "./ui";
import GuideContent from "./GuideContent";

export default function GuideDialog() {
  const { guide, guideInPage, openGuide } = useAppPick("guide", "guideInPage", "openGuide");
  const openHelpPage = useApp((s) => s.openHelpPage);
  if (!guide || guideInPage) return null;
  const fiche = guideOf(guide);
  if (!fiche) return null;

  return (
    <Modal
      title={fiche.title}
      description={fiche.summary}
      // Assez large pour les deux colonnes de la fiche (lecture | prérequis et pannes).
      width="max-w-5xl"
      onClose={() => openGuide(null)}
      footer={
        <Button
          variant="ghost"
          icon={<BookOpen size={14} />}
          onClick={() => {
            openGuide(null);
            openHelpPage(fiche.id);
          }}
        >
          Voir toute l'aide
        </Button>
      }
    >
      <GuideContent guide={fiche} />
    </Modal>
  );
}
