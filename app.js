const TURN_SPEED = 180; //turn speed in degrees per second
const FPS = 30; //frame per second
const SHIP_THRUST = 2; //acceleration of ship in pixels per second per second
const FRICTION = 0.005;
const LASER_SPD = 500; // speed of lasers in pixels per second
const LASER_DIST = 0.6; // max distance laser can travel as fraction of screen width
const LASER_EXPLODE_DUR = 0.1; // duration of the lasers' explosion in seconds
const LASER_MAX = 10; // maximum number of lasers on screen at once
const VELOCITY_MAX = 10; // maximum velocity a ship can be traveling at
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const ANIMAL_WORDS = ['meerkat', 'aardvark', 'addax', 'alligator', 'alpaca', 'anteater', 'antelope', 'aoudad', 'ape', 'argali', 'armadillo', 'baboon', 'badger', 'basilisk', 'bat', 'bear', 'beaver', 'bighorn', 'bison', 'boar', 'budgerigar', 'buffalo', 'bull', 'bunny', 'burro', 'camel', 'canary', 'capybara', 'cat', 'chameleon', 'chamois', 'cheetah', 'chimpanzee', 'chinchilla', 'chipmunk', 'civet', 'coati', 'colt', 'cougar', 'cow', 'coyote', 'crocodile', 'crow', 'deer', 'dingo', 'doe', 'dung beetle', 'dog', 'donkey', 'dormouse', 'dromedary', 'duckbill platypus', 'dugong', 'eland', 'elephant', 'elk', 'ermine', 'ewe', 'fawn', 'ferret', 'finch', 'fish', 'fox', 'frog', 'gazelle', 'gemsbok', 'gila monster', 'giraffe', 'gnu', 'goat', 'gopher', 'gorilla', 'grizzly bear', 'ground hog', 'guanaco', 'guinea pig', 'hamster', 'hare', 'hartebeest', 'hedgehog', 'highland cow', 'hippopotamus', 'hog', 'horse', 'hyena', 'ibex', 'iguana', 'impala', 'jackal', 'jaguar', 'jerboa', 'kangaroo', 'kitten', 'koala', 'lamb', 'lemur', 'leopard', 'lion', 'lizard', 'llama', 'lovebird', 'lynx', 'mandrill', 'mare', 'marmoset', 'marten', 'mink', 'mole', 'mongoose', 'monkey', 'moose', 'mountain goat', 'mouse', 'mule', 'musk deer', 'musk-ox', 'muskrat', 'mustang', 'mynah bird', 'newt', 'ocelot', 'okapi', 'opossum', 'orangutan', 'oryx', 'otter', 'ox', 'panda', 'panther', 'parakeet', 'parrot', 'peccary', 'pig', 'octopus', 'thorny devil', 'starfish', 'blue crab', 'snowy owl', 'chicken', 'rooster', 'bumble bee', 'eagle owl', 'polar bear', 'pony', 'porcupine', 'porpoise', 'prairie dog', 'pronghorn', 'puma', 'puppy', 'quagga', 'rabbit', 'raccoon', 'ram', 'rat', 'reindeer', 'rhinoceros', 'salamander', 'seal', 'sheep', 'shrew', 'silver fox', 'skunk', 'sloth', 'snake', 'springbok', 'squirrel', 'stallion', 'steer', 'tapir', 'tiger', 'toad', 'turtle', 'vicuna', 'walrus', 'warthog', 'waterbuck', 'weasel', 'whale', 'wildcat', 'bald eagle', 'wolf', 'wolverine', 'wombat', 'woodchuck', 'yak', 'zebra', 'zebu'];
const COLOR_WORDS = ['white', 'pearl', 'alabaster', 'snow', 'ivory', 'cream', 'eggshell', 'cotton', 'chiffon', 'salt', 'lace', 'coconut', 'linen', 'bone', 'daisy', 'powder', 'frost', 'porcelain', 'parchment', 'rice', 'tan', 'beige', 'macaroon', 'hazelwood', 'granola', 'oat', 'eggnog', 'fawn', 'sugar', 'sand', 'sepia', 'ltte', 'oyster', 'biscotti', 'parmesan', 'hazelnut', 'sandcastle', 'buttermilk', 'shortbread', 'yellow', 'canary', 'gold', 'daffodil', 'flaxen', 'butter', 'lemon', 'mustard', 'corn', 'medallion', 'dandelion', 'fire', 'bumblebee', 'banana', 'butterscotch', 'dijon', 'honey', 'blonde', 'pineapple', 'tuscan', 'orange', 'tangerine', 'marigold', 'cider', 'rust', 'ginger', 'tiger', 'fire', 'bronze', 'cantaloupe', 'apricot', 'clay', 'honey', 'carrot', 'squash', 'spice', 'marmalade', 'amber', 'sandstone', 'yam', 'red', 'cherry', 'rose', 'jam', 'merlot', 'garnet', 'crimson', 'ruby', 'scarlet', 'wine', 'brick', 'apple', 'mahogany', 'blood', 'sangria', 'berry', 'currant', 'blush', 'candy', 'lipstick', 'pink', 'rose', 'fuchsia', 'punch', 'blush', 'watermelon', 'flamingo', 'rouge', 'salmon', 'coral', 'peach', 'strawberry', 'rosewood', 'lemonade', 'taffy', 'bubblegum', 'crepe', 'magenta', 'purple', 'mauve', 'violet', 'boysenberry', 'lavender', 'plum', 'magenta', 'lilac', 'grape', 'periwinkle', 'sangria', 'eggplant', 'jam', 'iris', 'heather', 'amethyst', 'raisin', 'orchid', 'mulberry', 'wine', 'blue', 'slate', 'sky', 'navy', 'indigo', 'cobalt', 'teal', 'ocean', 'peacock', 'azure', 'cerulean', 'lapis', 'spruce', 'stone', 'aegean', 'berry', 'denim', 'admiral', 'sapphire', 'arctic', 'green', 'chartreuse', 'juniper', 'sage', 'lime', 'fern', 'olive', 'emerald', 'pear', 'moss', 'shamrock', 'seafoam', 'pine', 'parakeet', 'mint', 'seaweed', 'pickle', 'pistachio', 'basil', 'brown', 'coffee', 'mocha', 'peanut', 'carob', 'hickory', 'wood', 'pecan', 'walnut', 'caramel', 'gingerbread', 'syrup', 'chocolate', 'tortilla', 'umber', 'tawny', 'brunette', 'cinnamon', 'penny', 'cedar', 'grey', 'shadow', 'graphite', 'iron', 'pewter', 'cloud', 'silver', 'smoke', 'slate', 'anchor', 'ash', 'porpoise', 'dove', 'fog', 'flint', 'charcoal', 'pebble', 'lead', 'coin', 'fossil', 'black', 'ebony', 'crow', 'charcoal', 'midnight', 'ink', 'raven', 'oil', 'grease', 'onyx', 'pitch', 'soot', 'sable', 'jet', 'coal', 'metal', 'obsidian', 'jade', 'spider', 'leather'];

// Dependencies
var express = require('express');
var http = require('http');
var path = require('path');
var socketIO = require('socket.io');
var app = express();
var server = http.Server(app);
var io = socketIO(server);
app.set('port', 8080);
app.use('/static', express.static(__dirname + '/static'));
// Routing
app.get('/', function(request, response) {
  response.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/demo', function(request, response) {
  response.sendFile(path.join(__dirname, 'Blasteroid.html'));
});
// Starts the server.
server.listen(5000, function() {
  console.log('Starting server on port 5000');
});

// Add the WebSocket handlers
io.on('connection', function(socket) {
});

var world = {
players: {},
bullets: {}
}

// from https://stackoverflow.com/questions/3426404/create-a-hexadecimal-colour-based-on-a-string-with-javascript
function stringToColor(str) {
  var hash = 0;
  for (var i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  var color = '#';
  for (var i = 0; i < 3; i++) {
    var value = (hash >> (i * 8)) & 0xFF;
    color += ('00' + value.toString(16)).substr(-2);
  }
  return color;
}

// returns a random combination of color word + animal name
function generateRandomPlayerName() {
  // for example, 'green baboon' or 'porcelain bison'
  return `${COLOR_WORDS[Math.floor(Math.random()*COLOR_WORDS.length)]} ${ANIMAL_WORDS[Math.floor(Math.random()*ANIMAL_WORDS.length)]}`
}


io.on('connection', function(socket) {
  socket.on('new player', function() {
    world.players[socket.id] = {
      x: 300,
      y: 300,
      r: 30 / 2,
      a: 90 / 180 * Math.PI, //convert to radians
      rot: 0,
      thrusting: false,
      dx: 0,
      dy: 0,
      canShoot: true,
      lasers: [],
      score: 0,
      color: stringToColor(socket.id),
      // note that it's possible but improbable for 2 players to have the same name
      name: generateRandomPlayerName(),
    };
  });
socket.on('disconnect', function() {
  delete world.players[socket.id];
});

  socket.on('movement', function(data) {
    var player = world.players[socket.id] || {};
    if (data.left) {
      player.rot = TURN_SPEED / 180 * Math.PI / FPS;
      player.a += player.rot;
    }
    if (data.right) {
      player.rot = -TURN_SPEED / 180 * Math.PI / FPS;
      player.a += player.rot;
    }
    if (data.up) {
    //  player.x += 5;
      player.dx += SHIP_THRUST * Math.cos(player.a) / FPS;
      player.dy -= SHIP_THRUST * Math.sin(player.a) / FPS;
      const playerVelocity = Math.abs(player.dx) + Math.abs(player.dy);
      if (playerVelocity > VELOCITY_MAX) {
        const percentTooFast = (playerVelocity - VELOCITY_MAX) / VELOCITY_MAX;
        player.dx -= percentTooFast*player.dx;
        player.dy -= percentTooFast*player.dy;
      }
    } else {
      player.dx = player.dx * (1-FRICTION);
      player.dy = player.dy * (1-FRICTION);
    }
    if (data.shoot && player.canShoot) {
          io.sockets.emit('message', 'SHOOT');
          player.lasers.push({ // from the nose of the ship
              x: player.x + 4 / 3 * player.r * Math.cos(player.a),
              y: player.y - 4 / 3 * player.r * Math.sin(player.a),
              xv: LASER_SPD * Math.cos(player.a) / FPS,
              yv: -LASER_SPD * Math.sin(player.a) / FPS,
              dist: 0,
              explodeTime: 0
          });
      // disable shooting for .5 seconds
      player.canShoot = false;
      setTimeout(() => {
        player.canShoot = true;
      }, 500);
    }

    // move lasers
    // iterate backwards through the array of lasers (so we can very easily delete array items)
    for (let i = player.lasers.length - 1; i >=0 ; i--) {
      let laser = player.lasers[i];
      laser.x += laser.xv;
      laser.y += laser.yv;

      // if this laser is outside the bounds of our arena canvas
      if (laser.x > CANVAS_WIDTH || laser.x < 0 | laser.y > CANVAS_HEIGHT || laser.y < 0) {
        // delete this laser from our game
        player.lasers.splice(i, 1);
      }
    }
//screen wrap
    if (player.x < 0 - player.r) {
        player.x = 800 + player.r;
    } else if (player.x > 800 + player.r) {
        player.x = 0 - player.r;
    }
    if (player.y < 0 - player.r) {
        player.y = 600 + player.r;
    } else if (player.y > 600 + player.r) {
        player.y = 0 - player.r;
    } else {
    player.x += player.dx;
    player.y += player.dy;
  }
  });
});
setInterval(function() {
  io.sockets.emit('state', world);
}, 1000 / FPS);
