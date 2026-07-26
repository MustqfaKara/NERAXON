export function isPreExecutionFilter(message: string) {
  const normalized = message.toLocaleLowerCase("tr-TR");
  return [
    /likidite|liquidity|no liquidity/,
    /rota.*bulunamad|no route|route not found/,
    /legal restriction|restricted jurisdiction/,
    /denylist|engelli liste/,
    /güvenlik skoru|güvenlik değerlendirmesi/,
    /fiyat.*(?:sapması|risk sınır)|price deviation/,
    /slippage.*aşıyor|fiyat etkisi.*aşıyor/,
    /fee .* sınırını aşıyor/,
    /en az .* usd olmalı|işlem .* (?:tavanını|sınırını) aşıyor/,
    /maruziyet sınırı aşılacak/,
    /açık pozisyon sınırına ulaştı/,
    /günlük canlı zarar oranı .* sınırına ulaştı/,
    /devre kesici aktifken canlı emir gönderilemez/,
    /gas rezervi sonrasında kullanılabilir eth yok/,
    /kullanılabilir teminatı minimum emir için yetersiz/,
    /minimum tick emri|tick kurallarıyla karşılamıyor/,
    /quote.*(?:revert|alınamadı)/,
    /rota simülasyonu başarısız/,
    /genç piyasa.*cüzdan onayı|doğrulanmış satış rotası/,
    /hacmi .* sınırının altında|açık pozisyon değeri .* sınırının altında/,
    /doğrulanabilir .* havuzu bulunamadı/,
    /hooks kullanan .* havuzları .* izinli değil/,
  ].some((pattern) => pattern.test(normalized));
}

export function isTerminalExecutionRejection(message: string) {
  const normalized = message.toLowerCase();
  return [
    /hypercore emri reddedildi/,
    /order must have minimum value/,
    /mintradentlrejected/,
    /insufficient margin/,
    /reduce only.*rejected/,
  ].some((pattern) => pattern.test(normalized));
}
