import { NAME_MAX_LENGTH } from '../../shared/constants.js';

const COLORS = [
  'Amber', 'Ash', 'Azure', 'Basil', 'Berry', 'Blaze', 'Bronze', 'Cedar', 'Cherry', 'Cider', 'Clay',
  'Cobalt', 'Copper', 'Coral', 'Crimson', 'Denim', 'Ebony', 'Ember', 'Emerald', 'Fern', 'Flint',
  'Frost', 'Garnet', 'Ginger', 'Gold', 'Granite', 'Hazel', 'Honey', 'Indigo', 'Iron', 'Ivory',
  'Jade', 'Jet', 'Lava', 'Lemon', 'Lilac', 'Lime', 'Magenta', 'Maple', 'Mint', 'Mocha', 'Moss',
  'Neon', 'Ochre', 'Olive', 'Onyx', 'Opal', 'Orchid', 'Pearl', 'Pewter', 'Pine', 'Plum', 'Quartz',
  'Raven', 'Ruby', 'Rust', 'Saffron', 'Sage', 'Salt', 'Sand', 'Sapphire', 'Scarlet', 'Silver',
  'Slate', 'Smoke', 'Snow', 'Soot', 'Steel', 'Teal', 'Topaz', 'Umber', 'Violet', 'Walnut',
];

const ANIMALS = [
  'Aardvark', 'Addax', 'Alpaca', 'Badger', 'Bat', 'Bear', 'Beaver', 'Bison', 'Boar', 'Bobcat',
  'Camel', 'Capybara', 'Caracal', 'Cheetah', 'Civet', 'Coati', 'Condor', 'Cougar', 'Coyote',
  'Crow', 'Dingo', 'Dugong', 'Eagle', 'Eland', 'Elk', 'Ermine', 'Falcon', 'Ferret', 'Finch',
  'Fox', 'Gazelle', 'Gecko', 'Gibbon', 'Gnu', 'Gopher', 'Hare', 'Hawk', 'Hedgehog', 'Heron',
  'Hyena', 'Ibex', 'Iguana', 'Impala', 'Jackal', 'Jaguar', 'Koala', 'Lemur', 'Leopard', 'Lion',
  'Llama', 'Lynx', 'Mamba', 'Marten', 'Meerkat', 'Mink', 'Mole', 'Moose', 'Newt', 'Ocelot',
  'Okapi', 'Orca', 'Oryx', 'Osprey', 'Otter', 'Owl', 'Panda', 'Panther', 'Puma', 'Quokka',
  'Raccoon', 'Raven', 'Rhino', 'Shrew', 'Skunk', 'Sloth', 'Stoat', 'Tapir', 'Tiger', 'Toad',
  'Viper', 'Walrus', 'Weasel', 'Wolf', 'Wombat', 'Yak', 'Zebra',
];

/** A random "Colour Animal" name that fits within NAME_MAX_LENGTH. */
export function randomName(rng = Math.random) {
  let animal = ANIMALS[0];
  for (let attempt = 0; attempt < 20; attempt++) {
    animal = ANIMALS[Math.floor(rng() * ANIMALS.length)];
    const name = `${COLORS[Math.floor(rng() * COLORS.length)]} ${animal}`;
    if (name.length <= NAME_MAX_LENGTH) return name;
  }
  return animal;
}

/**
 * Normalises a player-supplied name: strips control and invisible formatting
 * characters, collapses whitespace and limits it to NAME_MAX_LENGTH code
 * points. Returns '' when nothing usable is left.
 */
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.normalize('NFC').replace(/\p{C}/gu, '').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(cleaned);
  return chars.length > NAME_MAX_LENGTH ? chars.slice(0, NAME_MAX_LENGTH).join('').trim() : cleaned;
}
