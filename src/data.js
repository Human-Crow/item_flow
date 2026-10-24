// Game data for Builderment: buildings, items, recipes.

/** building ids (blueprint `id` field) */
export const Building = Object.freeze({
    Belt: 3000,
    Belt_Splitter: 3001,
    Underground_Belt_Input: 3002,
    Underground_Belt_Output: 3003,
    Extractor: 3004,
    Workshop: 3005,
    Furnace: 3006,
    Machine_Shop: 3007,
    Industrial_Factory: 3008,
    Forge: 3009,
    Manufacturer: 3010,
    Storage: 3011,
    Robotic_Arm: 3012,
    Research_Lab: 3013,
    Earth_Teleporter: 3014,
    Pretty_Tree: 3015,
    Hazard_Cone: 3016,
    Broken_Pipe: 3017,
    Gear_Statue: 3018,
    Circuit_Statue: 3019,
    Steel_Statue: 3020,
    Particle_Statue: 3021,
    Pumpkin: 3022,
    Snowman: 3023,
    Gold_Vault: 3024,
    Earth_Statue: 3025,
    Fence: 3026,
    Concrete_Wall: 3027,
    Gem_Tree: 3029,
    Fir_Tree: 3030,
    Palm_Tree: 3031,
    Birch_Tree: 3032,
    Rock: 3033,
    Brown_Rock: 3034,
    Sharp_Rock: 3035,
    Barrel: 3036,
    Wooden_Crate: 3037,
    Coal_Power_Plant: 3038,
    Nuclear_Power_Plant: 3039,
    Uranium_Extractor: 3040,
    Writable_Sign: 3041,
});

/** item ids (filters of robotic arms, recipe outputs) */
export const Item = Object.freeze({
    Gold: 101,
    Gems: 102,
    Wood_Log: 1000,
    Wood_Plank: 1001,
    Wood_Frame: 1002,
    Copper_Ore: 1003,
    Copper_Ingot: 1004,
    Copper_Wire: 1005,
    Iron_Ore: 1006,
    Iron_Ingot: 1007,
    Iron_Gear: 1008,
    Stone: 1009,
    Sand: 1010,
    Silicon: 1011,
    Glass: 1012,
    Wolframite: 1013,
    Tungsten_Ore: 1014,
    Tungsten_Carbide: 1015,
    Coupler: 1016,
    Condenser_Lens: 1017,
    Heat_Sink: 1018,
    Iron_Plating: 1019,
    Electromagnet: 1020,
    Metal_Frame: 1021,
    Steel: 1022,
    Rotor: 1023,
    Steel_Rod: 1024,
    Concrete: 1025,
    Electric_Motor: 1026,
    Coal: 1027,
    Graphite: 1028,
    Logic_Circuit: 1029,
    Carbon_Fiber: 1030,
    Nano_Wire: 1031,
    Computer: 1032,
    Industrial_Frame: 1033,
    Stabilizer: 1034,
    Gyroscope: 1035,
    Magnetic_Field_Generator: 1036,
    Quantum_Entangler: 1037,
    Electron_Microscope: 1038,
    Turbocharger: 1039,
    Super_Computer: 1040,
    Atomic_Locator: 1041,
    Battery: 1042,
    Energy_Cube: 1043,
    Tank: 1044,
    Matter_Compressor: 1045,
    Particle_Glue: 1046,
    Matter_Duplicator: 1047,
    Earth_Token: 1048,
    Gem_Apple: 1049,
    Uranium_Ore: 1050,
    Enriched_Uranium: 1051,
    Empty_Fuel_Cell: 1052,
    Nuclear_Fuel_Cell: 1053,
});

/** recipe ids (`rec_fil` of factories); STD and ALT variants have their own id */
export const Recipe = Object.freeze({
    Wood_Plank: 2000,
    Wood_Frame: 2001,
    Copper_Ingot: 2002,
    Copper_Wire_STD: 2003,
    Iron_Ingot: 2004,
    Iron_Gear_STD: 2005,
    Sand: 2006,
    Silicon: 2007,
    Glass: 2008,
    Tungsten_Ore: 2009,
    Tungsten_Carbide_STD: 2010,
    Coupler: 2011,
    Condenser_Lens: 2012,
    Heat_Sink: 2013,
    Iron_Plating: 2014,
    Electromagnet_STD: 2015,
    Metal_Frame: 2016,
    Steel_STD: 2017,
    Rotor_STD: 2018,
    Steel_Rod: 2019,
    Concrete_STD: 2020,
    Electric_Motor_STD: 2021,
    Graphite: 2022,
    Logic_Circuit_STD: 2023,
    Carbon_Fiber: 2024,
    Nano_Wire: 2025,
    Computer: 2026,
    Industrial_Frame_STD: 2027,
    Stabilizer: 2028,
    Gyroscope: 2029,
    Magnetic_Field_Generator: 2030,
    Quantum_Entangler: 2031,
    Electron_Microscope: 2032,
    Turbocharger_STD: 2033,
    Super_Computer_STD: 2034,
    Atomic_Locator: 2035,
    Battery: 2036,
    Energy_Cube: 2037,
    Tank: 2038,
    Matter_Compressor: 2039,
    Particle_Glue: 2040,
    Matter_Duplicator: 2041,
    Earth_Token: 2042,
    Enriched_Uranium: 2043,
    Empty_Fuel_Cell: 2044,
    Nuclear_Fuel_Cell: 2045,
    Copper_Wire_ALT: 2046,
    Iron_Gear_ALT: 2047,
    Steel_ALT: 2048,
    Concrete_ALT: 2049,
    Electromagnet_ALT: 2050,
    Logic_Circuit_ALT: 2051,
    Electric_Motor_ALT: 2052,
    Industrial_Frame_ALT: 2053,
    Turbocharger_ALT: 2054,
    Super_Computer_ALT: 2055,
    Tungsten_Carbide_ALT: 2056,
    Rotor_ALT: 2057,
});

/** orientation (the worker's convention, the same for every building) */
export const Orientation = Object.freeze({
    North: 0,
    West: 1,
    South: 2,
    East: 3,
});

const reverse = (e) => Object.fromEntries(Object.entries(e).map(([k, v]) => [v, k]));
export const BUILDING_NAME = reverse(Building);
export const ITEM_NAME = reverse(Item);
export const RECIPE_NAME = reverse(Recipe);
export const ORIENTATION_NAME = reverse(Orientation);

/** tier is stored 0-based: add this for buildings / recipes with tiers (key: recipe id, else building id) */
export const TIER_CORRECTION = Object.freeze({"2000": 1, "2001": 1, "2002": 1, "2003": 1, "2004": 1, "2005": 1, "2006": 1, "2007": 1, "2008": 1, "2009": 1, "2010": 1, "2011": 1, "2012": 1, "2013": 1, "2014": 1, "2015": 1, "2016": 1, "2017": 1, "2018": 1, "2019": 1, "2020": 1, "2021": 1, "2022": 1, "2023": 1, "2024": 1, "2025": 1, "2026": 1, "2027": 1, "2028": 1, "2029": 1, "2030": 1, "2031": 1, "2032": 1, "2033": 1, "2034": 1, "2035": 1, "2036": 1, "2037": 1, "2038": 1, "2039": 1, "2040": 1, "2041": 1, "2043": 1, "2044": 1, "2045": 1, "2046": 1, "2047": 1, "2048": 1, "2049": 1, "2050": 1, "2051": 1, "2052": 1, "2053": 1, "2054": 1, "2055": 1, "2056": 1, "2057": 1, "3004": 1, "3012": 1, "3005": 1, "3006": 1, "3007": 1, "3008": 1, "3009": 1, "3010": 1, "3011": 1});

/** "Item|VARIANT" -> [output amount, seconds per craft, building, {material: amount}] */
export const RECIPE_DATA = Object.freeze({
 "Atomic_Locator|STD": [
  1,
  30,
  "Manufacturer",
  {
   "Super_Computer": 2,
   "Electron_Microscope": 2,
   "Concrete": 24,
   "Copper_Wire": 50
  }
 ],
 "Battery|STD": [
  1,
  24,
  "Machine_Shop",
  {
   "Electromagnet": 8,
   "Graphite": 8
  }
 ],
 "Carbon_Fiber|STD": [
  1,
  8,
  "Workshop",
  {
   "Graphite": 4
  }
 ],
 "Coal_Power_Plant|STD": [
  0.5,
  30,
  "Coal_Power_Plant",
  {
   "Coal": 5
  }
 ],
 "Computer|STD": [
  1,
  8,
  "Industrial_Factory",
  {
   "Metal_Frame": 1,
   "Heat_Sink": 3,
   "Logic_Circuit": 3
  }
 ],
 "Concrete|ALT": [
  1,
  12,
  "Forge",
  {
   "Stone": 20,
   "Wood_Frame": 4
  }
 ],
 "Concrete|STD": [
  1,
  8,
  "Forge",
  {
   "Sand": 10,
   "Steel_Rod": 1
  }
 ],
 "Condenser_Lens|STD": [
  1,
  3,
  "Workshop",
  {
   "Glass": 3
  }
 ],
 "Copper_Ingot|STD": [
  1,
  2,
  "Furnace",
  {
   "Copper_Ore": 1
  }
 ],
 "Copper_Wire|ALT": [
  8,
  8,
  "Workshop",
  {
   "Carbon_Fiber": 1
  }
 ],
 "Copper_Wire|STD": [
  2,
  4,
  "Workshop",
  {
   "Copper_Ingot": 3
  }
 ],
 "Coupler|STD": [
  1,
  10,
  "Workshop",
  {
   "Tungsten_Carbide": 1
  }
 ],
 "Earth_Token|STD": [
  1,
  42,
  "Earth_Teleporter",
  {
   "Matter_Duplicator": 1
  }
 ],
 "Electric_Motor|ALT": [
  1,
  22,
  "Industrial_Factory",
  {
   "Electromagnet": 6,
   "Steel": 6,
   "Empty_Fuel_Cell": 1
  }
 ],
 "Electric_Motor|STD": [
  1,
  20,
  "Industrial_Factory",
  {
   "Battery": 1,
   "Iron_Gear": 4,
   "Rotor": 2
  }
 ],
 "Electromagnet|ALT": [
  12,
  20,
  "Machine_Shop",
  {
   "Nano_Wire": 1,
   "Steel_Rod": 1
  }
 ],
 "Electromagnet|STD": [
  1,
  8,
  "Machine_Shop",
  {
   "Copper_Wire": 6,
   "Iron_Ingot": 2
  }
 ],
 "Electron_Microscope|STD": [
  1,
  24,
  "Manufacturer",
  {
   "Nano_Wire": 2,
   "Electromagnet": 8,
   "Condenser_Lens": 4,
   "Metal_Frame": 2
  }
 ],
 "Empty_Fuel_Cell|STD": [
  1,
  15,
  "Machine_Shop",
  {
   "Tungsten_Carbide": 3,
   "Glass": 5
  }
 ],
 "Energy_Cube|STD": [
  1,
  30,
  "Machine_Shop",
  {
   "Battery": 2,
   "Industrial_Frame": 1
  }
 ],
 "Enriched_Uranium|STD": [
  1,
  60,
  "Furnace",
  {
   "Uranium_Ore": 30
  }
 ],
 "Gem_Apple|STD": [
  1,
  300,
  "Gem_Tree",
  {}
 ],
 "Glass|STD": [
  1,
  6,
  "Furnace",
  {
   "Sand": 4
  }
 ],
 "Graphite|STD": [
  1,
  4,
  "Forge",
  {
   "Coal": 3,
   "Wood_Log": 3
  }
 ],
 "Gyroscope|STD": [
  1,
  12,
  "Machine_Shop",
  {
   "Copper_Wire": 12,
   "Rotor": 2
  }
 ],
 "Heat_Sink|STD": [
  1,
  6,
  "Workshop",
  {
   "Copper_Ingot": 5
  }
 ],
 "Industrial_Frame|ALT": [
  1,
  36,
  "Industrial_Factory",
  {
   "Steel": 18,
   "Iron_Plating": 10,
   "Carbon_Fiber": 4
  }
 ],
 "Industrial_Frame|STD": [
  1,
  20,
  "Industrial_Factory",
  {
   "Concrete": 6,
   "Metal_Frame": 2,
   "Tungsten_Carbide": 8
  }
 ],
 "Iron_Gear|ALT": [
  8,
  8,
  "Workshop",
  {
   "Steel": 1
  }
 ],
 "Iron_Gear|STD": [
  1,
  4,
  "Workshop",
  {
   "Iron_Ingot": 2
  }
 ],
 "Iron_Ingot|STD": [
  1,
  2,
  "Furnace",
  {
   "Iron_Ore": 1
  }
 ],
 "Iron_Plating|STD": [
  2,
  6,
  "Workshop",
  {
   "Iron_Ingot": 4
  }
 ],
 "Logic_Circuit|ALT": [
  1,
  8,
  "Machine_Shop",
  {
   "Iron_Plating": 1,
   "Heat_Sink": 1
  }
 ],
 "Logic_Circuit|STD": [
  1,
  6,
  "Machine_Shop",
  {
   "Copper_Wire": 3,
   "Silicon": 2
  }
 ],
 "Magnetic_Field_Generator|STD": [
  1,
  40,
  "Manufacturer",
  {
   "Stabilizer": 1,
   "Industrial_Frame": 1,
   "Electromagnet": 10,
   "Nano_Wire": 10
  }
 ],
 "Matter_Compressor|STD": [
  1,
  30,
  "Manufacturer",
  {
   "Industrial_Frame": 1,
   "Turbocharger": 2,
   "Electric_Motor": 2,
   "Tank": 1
  }
 ],
 "Matter_Duplicator|STD": [
  1,
  90,
  "Manufacturer",
  {
   "Atomic_Locator": 4,
   "Quantum_Entangler": 2,
   "Energy_Cube": 5,
   "Particle_Glue": 100
  }
 ],
 "Metal_Frame|STD": [
  1,
  12,
  "Machine_Shop",
  {
   "Wood_Frame": 1,
   "Iron_Plating": 4
  }
 ],
 "Nano_Wire|STD": [
  1,
  12,
  "Machine_Shop",
  {
   "Carbon_Fiber": 2,
   "Glass": 4
  }
 ],
 "Nuclear_Fuel_Cell|STD": [
  1,
  30,
  "Industrial_Factory",
  {
   "Empty_Fuel_Cell": 1,
   "Steel_Rod": 1,
   "Enriched_Uranium": 1
  }
 ],
 "Nuclear_Power_Plant|STD": [
  2,
  120,
  "Nuclear_Power_Plant",
  {
   "Nuclear_Fuel_Cell": 1
  }
 ],
 "Particle_Glue|STD": [
  10,
  30,
  "Workshop",
  {
   "Matter_Compressor": 1
  }
 ],
 "Quantum_Entangler|STD": [
  1,
  60,
  "Machine_Shop",
  {
   "Magnetic_Field_Generator": 1,
   "Stabilizer": 2
  }
 ],
 "Rotor|ALT": [
  1,
  18,
  "Machine_Shop",
  {
   "Copper_Ingot": 18,
   "Iron_Plating": 18
  }
 ],
 "Rotor|STD": [
  1,
  6,
  "Machine_Shop",
  {
   "Steel_Rod": 1,
   "Iron_Plating": 2
  }
 ],
 "Sand|STD": [
  1,
  1.5,
  "Workshop",
  {
   "Stone": 1
  }
 ],
 "Silicon|STD": [
  1,
  3,
  "Furnace",
  {
   "Sand": 2
  }
 ],
 "Stabilizer|STD": [
  1,
  24,
  "Industrial_Factory",
  {
   "Computer": 1,
   "Electric_Motor": 1,
   "Gyroscope": 2
  }
 ],
 "Steel|ALT": [
  1,
  6,
  "Forge",
  {
   "Iron_Ore": 4,
   "Coal": 4
  }
 ],
 "Steel|STD": [
  1,
  8,
  "Forge",
  {
   "Graphite": 1,
   "Iron_Ore": 6
  }
 ],
 "Steel_Rod|STD": [
  1,
  4,
  "Workshop",
  {
   "Steel": 3
  }
 ],
 "Super_Computer|ALT": [
  2,
  30,
  "Manufacturer",
  {
   "Computer": 2,
   "Silicon": 40,
   "Gyroscope": 2,
   "Industrial_Frame": 1
  }
 ],
 "Super_Computer|STD": [
  1,
  30,
  "Manufacturer",
  {
   "Computer": 2,
   "Heat_Sink": 8,
   "Turbocharger": 1,
   "Coupler": 8
  }
 ],
 "Tank|STD": [
  1,
  10,
  "Industrial_Factory",
  {
   "Glass": 2,
   "Concrete": 4,
   "Tungsten_Carbide": 4
  }
 ],
 "Tungsten_Carbide|ALT": [
  2,
  15,
  "Forge",
  {
   "Tungsten_Ore": 1,
   "Steel": 1
  }
 ],
 "Tungsten_Carbide|STD": [
  1,
  5,
  "Forge",
  {
   "Tungsten_Ore": 2,
   "Graphite": 1
  }
 ],
 "Tungsten_Ore|STD": [
  1,
  2.5,
  "Furnace",
  {
   "Wolframite": 5
  }
 ],
 "Turbocharger|ALT": [
  1,
  10,
  "Manufacturer",
  {
   "Heat_Sink": 4,
   "Computer": 1,
   "Gyroscope": 1,
   "Tungsten_Carbide": 1
  }
 ],
 "Turbocharger|STD": [
  1,
  15,
  "Manufacturer",
  {
   "Iron_Gear": 8,
   "Logic_Circuit": 4,
   "Nano_Wire": 2,
   "Coupler": 4
  }
 ],
 "Uranium_Ore|GEN1": [
  1,
  6,
  "Uranium_Extractor",
  {}
 ],
 "Uranium_Ore|GEN2": [
  1,
  1.2,
  "Uranium_Extractor",
  {}
 ],
 "Wood_Frame|STD": [
  1,
  8,
  "Workshop",
  {
   "Wood_Plank": 4
  }
 ],
 "Wood_Plank|STD": [
  1,
  4,
  "Workshop",
  {
   "Wood_Log": 1
  }
 ]
});
