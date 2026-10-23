/**
 * Limite le nombre de retours (issues GitHub) par personne : un délai minimal entre deux envois et
 * un plafond par heure. Sans cela, un seul membre pourrait remplir le dépôt d'issues en boucle, et
 * épuiser le quota d'API du jeton GitHub pour tout le monde.
 */
export class Cooldown {
  private readonly history = new Map<string, number[]>();

  constructor(
    private readonly minGapMs = 60_000,
    private readonly maxPerHour = 5,
    private readonly now: () => number = Date.now,
  ) {}

  /** Secondes à attendre avant le prochain envoi de `userId`, ou 0 s'il peut envoyer maintenant. */
  waitSeconds(userId: string): number {
    const t = this.now();
    const recent = (this.history.get(userId) ?? []).filter((at) => t - at < 3_600_000);
    this.history.set(userId, recent);
    const last = recent[recent.length - 1];
    const gap = last === undefined ? 0 : this.minGapMs - (t - last);
    const hourly = recent.length >= this.maxPerHour ? 3_600_000 - (t - (recent[0] ?? t)) : 0;
    return Math.max(0, Math.ceil(Math.max(gap, hourly) / 1000));
  }

  /** Annule le dernier enregistrement de `userId` (envoi réservé puis échoué). */
  forget(userId: string): void {
    this.history.get(userId)?.pop();
  }

  /** Enregistre un envoi (réservé avant le traitement, annulé par `forget` s'il échoue). */
  record(userId: string): void {
    const list = this.history.get(userId) ?? [];
    list.push(this.now());
    this.history.set(userId, list);
    // Ménage : les personnes sans envoi depuis une heure sont oubliées.
    if (this.history.size > 5_000) {
      const t = this.now();
      for (const [id, at] of this.history) if (!at.some((x) => t - x < 3_600_000)) this.history.delete(id);
    }
  }
}
