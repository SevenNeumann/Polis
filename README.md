# Polis

Плагин для Obsidian: группируй свои vault'ы по контекстам и переключайся между ними в один клик.

## Статус

Ранний skeleton. Реализовано:
- регистрация view во вкладке сайдбара (рядом с Files/Search/Bookmarks);
- модель данных: группы → vault'ы, у каждого есть имя, путь, необязательное описание;
- добавление/удаление групп и vault'ов (через `window.prompt`, временно — заменить на нормальные модалки);
- открытие vault'а по клику через `obsidian://open?path=...`;
- хранение данных в стандартном `data.json` плагина.

Не реализовано (следующие шаги):
- нормальные модальные окна вместо `window.prompt`;
- отображение описания группы/vault'а (tooltip? отдельная панель? раскрывающийся блок?);
- копирование самого плагина в новый vault при добавлении ("чтобы Polis был везде");
- экспорт/импорт данных для ручной синхронизации между vault'ами;
- settings tab.

## Разработка

```bash
npm install
npm run dev      # сборка в watch-режиме, main.js пересобирается при изменениях
npm run build    # прод-сборка (проверка типов + минификация)
```

### Как тестировать в реальном Obsidian

1. Создай (или используй существующий) тестовый vault.
2. В `<vault>/.obsidian/plugins/` создай папку `polis`.
3. Закинь туда (или сделай symlink) `manifest.json`, `main.js`, `styles.css` из корня проекта.
4. В Obsidian: Settings → Community plugins → включить Polis.
5. Удобнее всего — symlink на весь проект, чтобы `npm run dev` сразу подхватывался:

```bash
ln -s /path/to/obsidian-polis /path/to/TestVault/.obsidian/plugins/polis
```

## Git

```bash
cd obsidian-polis
git init
git add .
git commit -m "Initial skeleton: view, data model, open vault via URI"
```
