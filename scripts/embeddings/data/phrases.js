// Static, pre-translated phrase pools for dataset augmentation.
// Source phrases were chosen to look like realistic survey/feedback open-text
// answers across short and medium lengths. Kept small on purpose — we are
// augmenting, not generating a new corpus.

export const PHRASES = {
  de: {
    short: [
      "Super Produkt, sehr empfehlenswert.",
      "Funktioniert wie beschrieben.",
      "Die Bedienung ist intuitiv.",
      "Leider zu langsam für den Alltag.",
      "Nicht intuitiv genug.",
      "Toller Kundenservice, schnell und freundlich.",
      "Der Preis ist fair.",
      "Habe einen Fehler beim Login.",
      "Sehr zufrieden mit dem Ergebnis.",
      "Würde ich Freunden empfehlen.",
      "Das Dashboard lädt zu langsam.",
      "Insgesamt eine gute Erfahrung.",
      "Bitte mehr Vorlagen anbieten.",
      "Die App stürzt manchmal ab.",
      "Sehr klare Dokumentation.",
    ],
    medium: [
      "Die Umfrage war einfach aufzusetzen, aber bei mehrsprachigen Optionen ist der Editor unübersichtlich. Wir würden uns klarere Tabs pro Sprache wünschen.",
      "Die Auswertung der Antworten funktioniert gut, jedoch fehlt uns ein Export nach Excel mit allen Metadaten. Aktuell müssen wir das in einem Skript nachbauen.",
      "Wir nutzen das Tool im Support und sind zufrieden, allerdings wäre eine bessere Integration mit Slack hilfreich, gerade für eingehende Benachrichtigungen.",
      "Die Performance der Suche hat sich verschlechtert, seit wir den Datensatz auf über 50.000 Einträge erweitert haben. Eine Indexierung wäre sinnvoll.",
    ],
  },
  es: {
    short: [
      "Muy buen producto, lo recomiendo.",
      "Funciona como se describe.",
      "La interfaz es intuitiva.",
      "Demasiado lento para uso diario.",
      "Atención al cliente excelente.",
      "Precio justo para lo que ofrece.",
      "Tengo un error al iniciar sesión.",
      "Muy satisfecho con el resultado.",
      "Lo recomendaría a mis amigos.",
      "El panel tarda mucho en cargar.",
      "Experiencia en general positiva.",
      "Por favor añadan más plantillas.",
      "La aplicación a veces se cierra sola.",
      "Documentación muy clara.",
      "Faltan opciones de personalización.",
    ],
    medium: [
      "La encuesta fue fácil de configurar, pero el editor de opciones multilingües es confuso. Sería útil tener pestañas claras por idioma.",
      "El análisis de respuestas funciona bien, aunque echamos en falta un export a Excel con todos los metadatos. Hoy tenemos que reconstruirlo con un script.",
      "Usamos la herramienta en soporte y estamos contentos, pero una mejor integración con Slack ayudaría mucho con las notificaciones entrantes.",
      "El rendimiento de la búsqueda empeoró desde que ampliamos el conjunto de datos a más de 50.000 entradas. Sería razonable añadir un índice.",
    ],
  },
  fr: {
    short: [
      "Très bon produit, je le recommande.",
      "Fonctionne comme décrit.",
      "L'interface est intuitive.",
      "Trop lent pour un usage quotidien.",
      "Excellent service client.",
      "Prix correct pour ce qui est proposé.",
      "J'ai une erreur à la connexion.",
      "Très satisfait du résultat.",
      "Je le recommanderais à mes amis.",
      "Le tableau de bord met du temps à charger.",
      "Bonne expérience globale.",
      "Veuillez ajouter plus de modèles.",
      "L'application plante parfois.",
      "Documentation très claire.",
      "Manque d'options de personnalisation.",
    ],
    medium: [
      "L'enquête a été simple à configurer, mais l'éditeur multilingue est confus. Des onglets clairs par langue seraient les bienvenus.",
      "L'analyse des réponses fonctionne bien, mais il manque un export Excel avec toutes les métadonnées. Aujourd'hui nous le reconstruisons avec un script.",
      "Nous utilisons l'outil au support et nous sommes satisfaits, mais une meilleure intégration Slack aiderait beaucoup pour les notifications entrantes.",
      "Les performances de la recherche se sont dégradées depuis que nous avons étendu le jeu de données à plus de 50 000 entrées. Un index serait pertinent.",
    ],
  },
  ja: {
    short: [
      "とても良い製品です、おすすめします。",
      "説明通りに動作します。",
      "インターフェイスは直感的です。",
      "日常使いには遅すぎます。",
      "カスタマーサポートが素晴らしい。",
      "価格は妥当だと思います。",
      "ログインでエラーが出ます。",
      "結果にとても満足しています。",
      "友人にも勧めたいです。",
      "ダッシュボードの読み込みが遅い。",
      "全体的に良い体験でした。",
      "テンプレートをもっと増やしてほしい。",
      "アプリがたまにクラッシュします。",
      "ドキュメントがとても分かりやすい。",
      "カスタマイズのオプションが足りない。",
    ],
    medium: [
      "アンケートのセットアップは簡単でしたが、多言語オプションのエディタは見通しが悪いです。言語ごとに明確なタブが欲しいです。",
      "回答の分析機能はよくできていますが、すべてのメタデータを含む Excel エクスポートが欠けています。現状はスクリプトで再構築しています。",
      "サポート部門で使っており満足していますが、Slack 連携、特に着信通知の改善があると助かります。",
      "データセットを 5 万件以上に拡大してから検索のパフォーマンスが悪化しました。インデックスの追加が妥当だと思います。",
    ],
  },
};

// Pick a phrase of approximately the target length from a language pool.
// Falls back to whichever bucket has phrases close to the target length.
export function pickPhrase(lang, targetLen) {
  const pool = PHRASES[lang];
  if (!pool) throw new Error(`unknown language: ${lang}`);
  const bucket = targetLen >= 100 ? pool.medium : pool.short;
  return bucket[Math.floor(Math.random() * bucket.length)];
}
