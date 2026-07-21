# Governed Connector Layer (GCL) — L0 Contract

GCL, ürün adapter’larının dış servis bağlantılarını yönetişimli biçimde çağıracağı shared-api omurgasıdır. Bu L0, ürünler arasında runtime import oluşturmaz; her ürün yalnızca HTTP sözleşmesini kendi adapter’ı üzerinden kullanır.

## Connector contract

```ts
interface Connector<TInput, TData> {
  id: string
  kind: 'external-data' | 'media-generation'
  authKind: 'owner-token' | 'oauth'
  scopes: readonly string[]
  preflight?(input: TInput, ctx: ConnectorRunContext): Promise<void> | void
  run(input: TInput, ctx: ConnectorRunContext): Promise<{
    data: TData
    provenance: ConnectorProvenance
    confidence: number
  }>
}
```

`preflight` isteğe bağlıdır ama ağ çağrısından önce yapılandırma kapısını denetlemek içindir. Bir connector’ın çağrılabilmesi için şu ortak kurallar zorunludur:

- Owner-gate: ürün anahtarına ek olarak `X-Sectrai-Owner-Token` gerekir. Sunucuda `GCL_OWNER_TOKEN` yoksa istek `503 connector_unavailable`; token yanlışsa `403 owner_approval_required` döner.
- Scope-min: çağrının `scopes` dizisi boş olamaz ve connector’ın ilan ettiği kapsamların alt kümesi olmalıdır.
- Cost ve kota: her çağrıda pozitif `costCapCents` ve `requestedItems` gerekir. Her connector’ın yönetici tavanı ve günlük run/item kotası zorunludur; istek aşarsa iş kabul edilmez.
- Untrusted-content isolation: connector sonucu `provenance.untrustedContent` içinde `handling: 'data-only'` ve `UNTRUSTED_CONTENT_IS_DATA_NOT_INSTRUCTIONS` işaretiyle döner. Ürün/AI katmanı bunu talimat, araç çağrısı veya sistem mesajı olarak yorumlamamalıdır.
- Audit: başarılı ve başarısız başlatılmış run’lar, istek/scope/cost/kota özetiyle SHA-256 bağlı zincire yazılır. Her tenant zinciri PostgreSQL advisory lock ile serileştirilir.
- Fail-closed: connector kayıtlı değilse, owner onayı yoksa, token/actor/limit/kota yapılandırılmamışsa veya upstream hata verirse görünür hata döner; local/in-memory/başka provider fallback’i yoktur.

`confidence` kaynak doğruluğu iddiası değildir. Sentetik GM4 video adapter’ı gerçek artefakt üretmediği için `0` döndürür.

## HTTP contract

Tüm GCL uçları önce mevcut `X-Sectrai-Product-Key` ürün sınırını kullanır.

```text
POST /api/products/:product/workspaces/:workspaceId/gcl/connectors/:connectorId/runs
GET  /api/products/:product/workspaces/:workspaceId/gcl/extensions
POST /api/products/:product/workspaces/:workspaceId/gcl/extensions
PATCH /api/products/:product/workspaces/:workspaceId/gcl/extensions/:recordId
DELETE /api/products/:product/workspaces/:workspaceId/gcl/extensions/:recordId
POST /api/products/:product/workspaces/:workspaceId/gcl/extensions/suggestions
```

Connector run örneği:

```json
{
  "input": { "prompt": "synthetic product introduction", "durationSeconds": 15, "aspectRatio": "16:9", "variants": 1 },
  "scopes": ["video:text-to-video"],
  "costCapCents": 50,
  "requestedItems": 1
}
```

Bu uç ayrıca `X-Sectrai-Owner-Token` ve denetlenebilir bir `X-Sectrai-Owner-Actor` ister. `input` seçilen Actor’ın Store şemasına ait veri nesnesidir; actor şeması canlıya açılmadan önce owner tarafından doğrulanmalıdır.

## Extensions marketplace model

```ts
type Extension = {
  id: string
  name: string
  sector: string[]
  role: 'ai-support' | 'add-on-module'
  connectorId: string
  defaultScopes: string[]
  consentState: 'pending' | 'granted' | 'revoked'
}
```

Extension kayıtları mevcut `Record` omurgasında `moduleId = gcl-extensions` ile tutulur; migration eklenmedi. Oluşturma/değiştirme/silme owner-token ister. AI önerisi saf ve deterministik bir fonksiyondur: sektör, aktif modüller ve son komutla eşleşen **yalnızca `granted`** kayıtları önerir; response her zaman `requiresOwnerApproval: true` taşır ve hiçbir kaydı etkinleştirmez. Landing/activation UI L1 kapsamındadır.

`gcl-audit` ve `gcl-usage` da aynı tabloyu kullanır, fakat genel records uçları bu üç ayrılmış modüle erişemez. Böylece normal kayıt CRUD’u audit/usage zincirini değiştiremez.

## GM4 synthetic-only operating configuration

```dotenv
# Owner token yalnızca deploy owner ortamında tutulur; commit edilmez.
GCL_OWNER_TOKEN="replace-with-owner-secret"
GCL_VIDEO_LIVE_ENABLED=false
GCL_VIDEO_MAX_COST_CENTS=50
GCL_VIDEO_MAX_ITEMS=2
GCL_VIDEO_MAX_DURATION_SECONDS=30
GCL_VIDEO_MAX_PROMPT_CHARACTERS=2000
GCL_VIDEO_DAILY_RUN_QUOTA=10
GCL_VIDEO_DAILY_ITEM_QUOTA=20
GCL_VIDEO_QUEUE_MAX_QUEUED_JOBS=25
```

Bu çalışma ağacında sağlayıcı endpoint’i, SDK’sı, API anahtarı veya canlı çalışma yolu yoktur. `GCL_VIDEO_LIVE_ENABLED=true` dahi canlı açmaz: `LIVE_DISABLED` ile fail-closed olur. Başarılı run yalnız `SYNTHETIC` kuyruğa alınmış iş ve `NOT_GENERATED` artefakt durumu döndürür.

## Privacy, KVKK and content boundary

Prompt ve asset referansı potansiyel kişisel veri sayılabilir. Ürün adapter’ı veri minimizasyonu, açık amaç, uygun aydınlatma/açık rıza, saklama süresi ve erişim taleplerini kendi KVKK sorumluluğunda uygular. İçerik `data-only` kalır; talimat, araç çağrısı veya sistem mesajı olarak yorumlanmaz. Gerçek bir sağlayıcı bağlantısı bu GM4 kapsamının dışındadır ve ayrı owner/orkestratör kararı gerektirir.
