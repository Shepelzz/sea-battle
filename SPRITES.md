# Спрайты для растрового скина карты

Папка: **`public/sprites/`**. Имена файлов — **строго как ниже**, движок будет искать их по имени.
Формат — **PNG**. Всё, кроме воды и облаков, — на **прозрачном фоне**.

## Как генерить (общее для всех промптов)

1. **Прозрачный фон.** Если Grok не отдаёт альфу — генери на ровном фоне **чистого пурпурного `#FF00FF`** (пиши в промпт `on a solid flat magenta #FF00FF background`), я вырежу его автоматически. Ровный, без градиента и теней на фоне.
2. **Размер** — квадрат 1024×1024, корабли — 1024×512 (горизонтально). Больше можно, я ужму. Меньше 512 не надо.
3. **Ракурс — строго сверху (top-down, orthographic)**. Корабли крутятся в игре на любой угол, поэтому у них не должно быть перспективы и тени на воде — тень дорисует движок. Острова не крутятся, им можно лёгкий наклон камеры (почти сверху) и тень вправо-вниз.
4. **Свет всегда сверху-слева**, тени вправо-вниз. Иначе на карте рядом лягут объекты с разным светом и это режет глаз.
5. **Без текста, цифр, водяных знаков, рамок, интерфейса.** Один объект по центру кадра, занимает ~85% кадра.
6. **Командный цвет.** У кораблей игроков **паруса и вымпел — чисто-белые `#FFFFFF`**, без теней и складок серым: движок перекрашивает белое в цвет игрока (красный/синий/зелёный…). Ничего другого белого в спрайте корабля быть не должно (пена, блики — не белые, а светло-серые/голубоватые).
7. Начинай каждый промпт с **общего блока стиля** — так все спрайты будут из одного мира:

```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
```

Дальше в каждом промпте — только конкретика объекта. Ниже промпты уже с этим блоком, копируй целиком.

---

## 1. Вода

### `water.png` — 1024×1024, **бесшовный тайл**
Замостит всё море. Спокойная глубокая синяя вода, лёгкие блики, без пены и берегов.

```
Seamless tileable texture of calm deep ocean water seen directly from above, rich royal blue to deep teal, gentle small ripples and soft sun glints, subtle lighter turquoise wisps, no foam, no shore, no horizon, no objects, no text. Perfectly seamless, edges must tile without visible seams, uniform lighting, square 1024x1024.
```

> Если тайл выйдет не идеально бесшовным — не страшно, движок кладёт его «зеркалкой» (каждый второй тайл отражён), швы прячутся.

---

## 2. Базы игроков (остров с фортом)

Форт — **пятиугольный бастионный (звезда)**, как в игре сейчас. **Без флагов** — флаг цвета игрока движок рисует сам. Остров занимает почти весь кадр, вокруг — узкая полоска светлой бирюзовой отмели и пены, дальше прозрачно.

### `base-island-a.png` — 1024×1024
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
A tropical island seen from directly above (top-down, near-orthographic), roughly round with an irregular coastline, sandy beaches, palm trees and lush green vegetation around the edge. In the center a large stone star fort: a five-pointed bastion fortress with thick sandstone walls, an inner courtyard with small red-roofed houses, a small inner citadel, cannons on the bastion tips. No flags, no flagpoles. A thin ring of light turquoise shallow water with white foam along the shore, everything beyond the shallows is transparent background. Shadows fall to the bottom-right.
```

### `base-island-b.png` — 1024×1024 (второй вариант, для разнообразия)
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
A rocky volcanic island seen from directly above (top-down, near-orthographic), irregular coastline with grey cliffs on one side and a sandy cove on the other, palm groves and tropical bushes. In the center a large stone star fort: a five-pointed bastion fortress with dark basalt walls, inner courtyard with warehouses and a lighthouse tower in the citadel, cannons on the bastion tips. No flags, no flagpoles. A thin ring of light turquoise shallow water with white foam along the shore, everything beyond the shallows is transparent background. Shadows fall to the bottom-right.
```

### `base-island-ruined.png` — 1024×1024 (выбывший игрок)
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
A tropical island seen from directly above (top-down, near-orthographic), sandy beaches and palm trees, some palms broken. In the center the ruins of a five-pointed star fort: collapsed sandstone bastion walls, rubble, scorched black craters, burnt roofless houses, thin grey smoke wisps. No flags. Thin ring of light turquoise shallow water with foam along the shore, transparent beyond. Shadows fall to the bottom-right.
```

---

## 3. Малые острова (клад / аванпост)

Четыре разных, чтобы карта не выглядела штампованной. **Пустые** — без сундуков и построек: сундук и постройки движок кладёт поверх отдельными спрайтами. Остров занимает ~80% кадра, вокруг узкая отмель, дальше прозрачно.

### `island-1.png` — 1024×1024
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
A small tropical islet seen from directly above (top-down), roughly round, white sand beach, three tall palm trees and low green bushes, a few dark rocks at the water's edge. Empty flat sandy clearing in the very center. Thin ring of turquoise shallow water and foam, transparent beyond. Shadows to the bottom-right.
```

### `island-2.png` — 1024×1024
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
A small rocky islet seen from directly above (top-down), irregular elongated shape, grey and brown boulders, patches of moss and grass, one crooked palm tree, tiny sandy spit. Empty flat clearing in the very center. Thin ring of turquoise shallow water and foam, transparent beyond. Shadows to the bottom-right.
```

### `island-3.png` — 1024×1024
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
A small crescent-shaped sandy atoll seen from directly above (top-down), bright white sand, a cluster of five palm trees on the thicker end, a shallow turquoise lagoon inside the crescent, small driftwood. Empty flat clearing in the very center. Thin ring of foam, transparent beyond. Shadows to the bottom-right.
```

### `island-4.png` — 1024×1024
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
A small jungle islet seen from directly above (top-down), roughly triangular, dense dark green tropical canopy with a few bright flowering trees, a narrow beach, a tiny freshwater pool. Empty flat clearing in the very center. Thin ring of turquoise shallow water and foam, transparent beyond. Shadows to the bottom-right.
```

---

## 4. Постройки на островах (кладутся поверх малого острова)

512×512, объект ~70% кадра, строго сверху, прозрачный фон. Три уровня аванпоста — должны читаться как рост: лагерь → пост → форт.

### `outpost-1.png` — уровень 1, лагерь ⛺
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
A small pioneer camp seen from directly above (top-down): one canvas tent, a campfire with a thin smoke wisp, a few wooden crates and barrels, a short wooden palisade section. No flags. Shadows to the bottom-right.
```

### `outpost-2.png` — уровень 2, торговый пост 🏪
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
A small wooden trading post seen from directly above (top-down): a timber warehouse with a red tiled roof, a wooden watchtower, a short pier with stacked crates and barrels, a round wooden palisade. No flags. Shadows to the bottom-right.
```

### `outpost-3.png` — уровень 3, форт с пушкой 🏰
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
A small square stone fort seen from directly above (top-down): grey stone walls with four corner towers, an inner keep with a red roof, a large black mortar cannon on a wooden platform pointing outward. No flags. Shadows to the bottom-right.
```

### `chest.png` — клад 💰 (512×512)
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
An open wooden pirate treasure chest seen from directly above (top-down, slightly tilted), iron bands, overflowing with gold coins, a few coins spilled on the ground beside it, a small pile of gold bars. Shadows to the bottom-right.
```

---

## 5. Корабли игроков

**1024×512, нос СТРОГО ВПРАВО, вид строго сверху**, без тени на воде и без кильватерного следа (движок рисует сам). Корпус — натуральное дерево. **Паруса и вымпел на корме — чисто-белые `#FFFFFF`**, плоские, без серых складок (перекрашиваются в цвет игрока). Палуба светлая, но не белая. Пропорции: корабль занимает ~90% ширины кадра.

Размеры в игре (относительная длина): баркас 34 · шхуна 42 · бриг 50 · фрегат 60 · линкор 72 · ремонтник 44 · авианосец 132. Детализация должна читаться и при уменьшении до ~50 px.

### `ship-barkas.png` — баркас (рыбак)
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
A small wooden fishing boat seen from directly above (strict top-down, orthographic), bow pointing to the RIGHT, no mast, three wooden thwart benches, a folded brown fishing net and a few wicker baskets at the stern (left end), a tiny pure white #FFFFFF pennant flag at the stern. Natural oak hull, light plank deck. No shadow on water, no wake, no waves.
```

### `ship-shkhuna.png` — шхуна (1 мачта)
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
A sleek wooden schooner seen from directly above (strict top-down, orthographic), bow pointing to the RIGHT, one mast with one wide square sail, the sail is pure flat white #FFFFFF with no shading, two small cannons per side, a pure white pennant at the stern (left end). Natural oak hull, light plank deck. No shadow on water, no wake, no waves.
```

### `ship-brig.png` — бриг (2 мачты)
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
A wooden brig warship seen from directly above (strict top-down, orthographic), bow pointing to the RIGHT, two masts with square sails, sails pure flat white #FFFFFF with no shading, three cannons per side, a pure white pennant at the stern (left end). Dark oak hull with a golden trim stripe, light plank deck. No shadow on water, no wake, no waves.
```

### `ship-fregat.png` — фрегат (3 мачты)
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
A wooden frigate warship seen from directly above (strict top-down, orthographic), bow pointing to the RIGHT, three masts with square sails, sails pure flat white #FFFFFF with no shading, four cannons per side, a pure white pennant at the stern (left end). Dark oak hull with golden trim, light plank deck, a raised quarterdeck at the stern. No shadow on water, no wake, no waves.
```

### `ship-linkor.png` — линкор (тяжёлый, 3 мачты)
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
A massive wooden ship of the line seen from directly above (strict top-down, orthographic), bow pointing to the RIGHT, wide heavy hull, three tall masts with large square sails, sails pure flat white #FFFFFF with no shading, two rows of cannons per side (six per side), ornate golden stern decoration, a pure white pennant at the stern (left end). Very dark oak hull with gold and red trim, light plank deck. No shadow on water, no wake, no waves.
```

### `ship-repair.png` — ремонтник
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
A boxy wooden repair barge seen from directly above (strict top-down, orthographic), bow pointing to the RIGHT, wide flat hull, no sails, a wooden crane arm, stacked planks, rope coils and barrels on deck, a large yellow cross painted on the deck, a pure white #FFFFFF pennant at the stern (left end). Natural oak hull. No shadow on water, no wake, no waves.
```

### `ship-carrier.png` — авианосец (чит-корабль)
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
A modern grey aircraft carrier seen from directly above (strict top-down, orthographic), bow pointing to the RIGHT, long flat flight deck with yellow runway markings, an island superstructure on the far side of the deck, a few small jets parked on deck, a pure white #FFFFFF flag on the superstructure. Steel grey hull. No shadow on water, no wake, no waves.
```

---

## 6. Пираты (нейтральные)

Цвет им не перекрашивается — паруса **не** белые.

### `ship-pirate.png` — пират (2 мачты, 1024×512)
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
A menacing pirate brig seen from directly above (strict top-down, orthographic), bow pointing to the RIGHT, black tarred hull with dark red trim, two masts with tattered dark charcoal grey square sails, a black skull-and-crossbones flag at the stern (left end), three cannons per side, dark weathered deck. No shadow on water, no wake, no waves.
```

### `ship-pirate-boss.png` — пиратский босс (крупнее, 1024×512)
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
A huge legendary pirate flagship seen from directly above (strict top-down, orthographic), bow pointing to the RIGHT, black hull with gold skull ornaments, three masts with blood-red square sails, a large black skull-and-crossbones flag at the stern (left end), two rows of cannons per side, a golden crown emblem painted on the deck. No shadow on water, no wake, no waves.
```

---

## 7. Декор (необязательно, но оживит карту)

### `fish-school.png` — косяк рыбы для рыбных мест (512×512)
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
A school of seven small silvery-blue fish seen from directly above (top-down), swimming together in a loose oval formation, semi-transparent look as if just under the water surface, no water, no background.
```

### `buoy.png` — буй-маркер рыбного места (512×512)
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, rich saturated colors, clean crisp edges, soft studio lighting from the top-left, no text, no watermark, no UI, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
A small red-and-white striped fishing buoy with a tiny lantern on top, seen from directly above (top-down), a rope loop, no water, no background.
```

### `cloud-1.png`, `cloud-2.png` — облака, плывущие над картой (1024×512)
Здесь фон **обязательно прозрачный** — полупрозрачные края нужны. Если Grok прозрачность не даёт — пропусти, движок нарисует облака сам.
```
Game asset, stylized semi-realistic 3D render, soft volumetric white cumulus cloud seen from directly above (top-down), fluffy with soft translucent feathered edges, no ground, no sky, isolated on a fully transparent background, PNG with alpha.
```

### `compass-rose.png` — роза ветров для компаса (512×512)
```
Game asset, stylized semi-realistic 3D render, mobile strategy game art style, clean crisp edges, no text, no watermark, single object centered, isolated on a transparent background (or flat magenta #FF00FF background).
An antique brass and navy-blue nautical compass rose seen from directly above (top-down), eight points, ornate engraving, N/E/S/W marks as simple decorative points without letters, a small red needle pointing up.
```

---

## Что остаётся нарисовано движком (спрайтов не нужно)

Сетка-клетка поверх воды (тонкая, как на эскизе), туман войны, флаги цвета игрока над фортами и аванпостами, огонь и дым горящих баз, кильватерные следы, ядра, взрывы, всплывающие цифры, полоски HP, пунктирные круги радиусов, штурвал, отмель у островов (свечение под спрайтом), тени под кораблями, номера кладов и подписи.

## Чек-лист перед тем, как класть в папку

- [ ] имя файла строго как в списке, нижний регистр, `.png`
- [ ] прозрачный фон **или** ровный `#FF00FF`
- [ ] корабли: нос вправо, вид строго сверху, без тени и следа, белые паруса
- [ ] острова/постройки: без флагов, свет сверху-слева
- [ ] без текста и водяных знаков
