# Источники интерфейсов и допущения

Проверено при реализации 16 октября 2026 года. Документация и ответы API могут измениться; адаптеры отклоняют неизвестные структуры вместо предположения нулевых расходов.

- [Polymarket — Discover Markets](https://docs.polymarket.com/market-data/discover-markets): Gamma markets, slug, keyset pagination. На реальном запросе `offset=2100` старого endpoint возвращал 422 с требованием `/markets/keyset`; используется cursor API.
- [Polymarket — Prices and Order Books](https://docs.polymarket.com/market-data/prices-order-books): `GET /book`, `asset_id`, строковые цены/размеры, `tick_size`, `min_order_size`; для V2 используются `positionIds`.
- [Polymarket — Fees](https://docs.polymarket.com/trading/fees): fee = C × rate × p × (1-p). Поддерживается exponent=1; округление расходов вверх консервативно на уровне ценовых уровней. Результат не является точным fee расчётом отдельных matching fills.
- [Polymarket — Real-Time Data](https://docs.polymarket.com/market-data/realtime-data): снимки и абсолютные изменения размера уровня, события tick size. При изменении шага требуется новый полный снимок; REST восстанавливает состояние.
- [Polymarket — Geographic Restrictions](https://help.polymarket.com/en/articles/13364163-geographic-restrictions): доступность пользователя и расположения хоста должны проверяться до реальной торговли.
- [Limitless — Browse Active Markets](https://docs.limitless.exchange/api-reference/markets/browse-active): limit<=25, страницы, вложенные рынки групп.
- [Limitless — Get Orderbook](https://docs.limitless.exchange/api-reference/trading/orderbook): размеры в 1e-6 shares, NO из зеркального YES-стакана. REST не гарантирует свежесть; `lastTradePrice` не используется вместо доступной цены.
- [Limitless — Market Data WebSocket](https://docs.limitless.exchange/developers/websocket/market-data): `subscribe_market_prices`, `marketSlugs`, полные `orderbookUpdate`, версии и timestamp. LP `minSize` не является минимумом исполнимого ордера.
- [Limitless — WebSocket Overview](https://docs.limitless.exchange/developers/websocket/overview): публичные подписки без API-ключей, встроенный Socket.IO heartbeat, переподключение после потери связи.
- [Limitless — Fees](https://docs.limitless.exchange/user-guide/fees): покупатель CLOB платит 0,40–3,00% в контрактах. Формула кривой не опубликована; применяется верхняя граница 3%, без скидок. Точные индивидуальные комиссии проверяются на последующих этапах.
- [Bybit — Server Time](https://bybit-exchange.github.io/docs/v5/market/time): только публичный замер ответа. Аккаунт, API-ключи, депозиты и выводы Bybit на текущем этапе не подключаются.

Ограничения: источник timestamp может означать последнее изменение, а не время снимка; редкие обновления могут отклоняться как устаревшие. Это консервативно и снижает число оценок. REST/WS timestamps не дают атомарного состояния двух независимых площадок. Неизвестны гарантированная доступность ликвидности после отправки заявки, индивидуальные ограничения ордера Limitless и исход возможных споров о выплатах. Расчёт предполагает долларовую эквивалентность залога; риск pUSD/USDC и маршрут конвертации ещё не смоделированы.
