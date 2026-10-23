#!/usr/bin/env python3
"""Export website catalog from actual Guilds sources; never runs Gradle or modifies runtime data."""
from pathlib import Path
import argparse,json,re,shutil
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--guild-source',type=Path)
args=parser.parse_args()
site=Path(__file__).resolve().parents[1]
guild=args.guild_source or site.parent/'minecraft/source/integration/PORT_26_3/NEOFORGE_GUILD_MOD'
r=guild/'src/main/resources';java=guild/'src/main/java/ua/homecraft/guild/server'
source=(java/'HomeCraftGuildConfig.java').read_text()
lang=json.loads((r/'assets/homecraftguild/lang/uk_ua.json').read_text())
legacy=dict(re.findall(r'Map.entry\("([^"\n]+)", "([^"\n]+)"\)',(java/'GuildTradeLocalization.java').read_text()))
constants=dict(re.findall(r'private static final String (\w+_TRADE) = "([^"\n]+)"',source))
def body(method):
 m=re.search(r'private static String '+method+r'\([^)]*\)\s*\{',source)
 if not m:raise ValueError('Missing method '+method)
 end=re.search(r'\n    (?:private|public) static ',source[m.end():])
 return source[m.end():m.end()+end.start()] if end else source[m.end():]
def trades(method):
 text=body(method);out=re.findall(r'"(buy=[^"\n]+)"',text)
 for name,trade in constants.items():
  if re.search(r'\b'+name+r'\b',text):out.append(trade)
 for sell,name,ench,xp,extra in re.findall(r'maxEmeraldTrade\("([^"]+)", "([^"]+)", "([^"]+)", (\d+)(?:, "([^"]+)")?\)',text):
  key=legacy.get(name.lower(),'')
  out.append(f'buy=minecraft:emerald,buyCount=64,buy2=minecraft:emerald,buy2Count=64,sell={sell},sellCount=1,max=2,xp={xp},role=member,limit=1,'+(f'nameKey={key}' if key else f'name={name}')+f',ench={ench}'+(','+extra if extra else ''))
 for other in re.findall(r'\b(default\w+Trades)\(\)',text):
  if other!=method:out.extend(trades(other))
 return list(dict.fromkeys(out))
base_names={'stone':'Камінь','lapis_lazuli':'Лазурит','amethyst_shard':'Аметистовий уламок','emerald':'Смарагд','bread':'Хліб','baked_potato':'Печена картопля','cooked_chicken':'Смажена курятина','cooked_cod':'Смажена тріска','cooked_salmon':'Смажений лосось','cooked_mutton':'Смажена баранина','cooked_porkchop':'Смажена свинина','cooked_beef':'Стейк','pumpkin_pie':'Гарбузовий пиріг','apple':'Яблуко','golden_carrot':'Золота морква','melon_slice':'Скибка кавуна','beetroot_soup':'Буряковий суп','suspicious_stew':'Підозріле рагу','honey_bottle':'Пляшечка меду','golden_apple':'Золоте яблуко','enchanted_golden_apple':'Зачароване золоте яблуко','copper_ingot':'Мідний зливок','iron_ingot':'Залізний зливок','gold_ingot':'Золотий зливок','netherite_ingot':'Незеритовий зливок','banner':'Прапор','banners':'Будь-який прапор'}
labels={k:v for k,v in lang.items() if k.startswith(('npc.','trade_name.','item.','block.'))}
labels.update({'minecraft:'+k:v for k,v in base_names.items()})
recipes={}
for p in sorted((r/'data/homecraftguild/recipe').glob('*.json')):
 value=json.loads(p.read_text());recipes[value['result']['id']]=value
items=[]
for id,recipe in recipes.items():
 name=id.split(':')[1];dest=lang.get('tooltip.homecraftguild.'+name+'.destination',lang.get('tooltip.homecraftguild.guild_banner.description',''))
 icon='/assets/items/'+('guild_banner' if name=='guild_banner' else name)+'.png'
 items.append({'itemId':id,'name':lang.get('item.homecraftguild.'+name,lang.get('block.homecraftguild.'+name,name)), 'category':'guild' if name=='guild_banner' else 'teleport','description':dest,'icon':icon,'recipe':recipe})
 target=site/'public'/icon.lstrip('/');target.parent.mkdir(parents=True,exist_ok=True)
 shutil.copy2(r/'assets/homecraftguild/textures/item'/('guild_banner_icon.png' if name=='guild_banner' else name+'.png'),target)
vendors=[]
for id,method in {'trader_basic':'defaultGuildTraderTrades','trader_food':'defaultFoodTrades','trader_tools':'defaultToolTrades','trader_weapons':'defaultWeaponTrades','trader_armor':'defaultArmorTrades','trader_elite':'defaultEliteTrades'}.items():
 key='npc.homecraftguild.'+('trader' if id=='trader_basic' else id)
 vendors.append({'id':id,'name':lang.get(key,id),'kind':'trader','enabled':False,'position':None,'trades':trades(method)})
vendors.insert(0,{'id':'guild_master','name':lang['npc.homecraftguild.guild_master'],'kind':'system','enabled':False,'position':None,'trades':[]})
seed={'schemaVersion':1,'source':'guild-source-defaults','items':items,'traders':vendors,'labels':labels}
out=site/'catalog/defaults.json';out.parent.mkdir(exist_ok=True);out.write_text(json.dumps(seed,ensure_ascii=False,indent=2)+'\n')
print('Exported',len(items),'craftable items and',sum(len(v['trades']) for v in vendors),'offers from',len(vendors),'NPC definitions. No NPC coordinates invented.')
