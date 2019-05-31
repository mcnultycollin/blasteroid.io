var socket = io();
const FPS = 60; //frame per second
const SHIP_SIZE = 30; //ship height in pixels
const SHIP_THRUST = 5; //acceleration of ship in pixels per second per second
const ROID_JAG = 0.4; // jaggedness of the asteroids (0 = none, 1 = lots)
const ROID_NUM = 3; // starting number of asteroids
const ROID_SIZE = 100; // starting size of asteroids in pixels
const ROID_SPD = 20; // max starting speed of asteroids in pixels per second
const ROID_VERT = 10; // average number of vertices on each asteroid
var roids = [];

var canvas = document.getElementById('canvas');
canvas.width = 800;
canvas.height = 600;
var context = canvas.getContext('2d');

socket.on('message', function(data) {
  console.log(data);
});

var movement = {
  up: false,
  down: false,
  left: false,
  right: false,
  shoot: false
}
document.addEventListener('keydown', function(event) {
  switch (event.keyCode) {
    case 65: // A
      movement.left = true;
      break;
    case 68: // D
      movement.right = true;
      break;
    case 87: // W
      movement.up = true;
      break;
    case 32: //space
      movement.shoot = true;
      break;
  }
});
document.addEventListener('keyup', function(event) {
  switch (event.keyCode) {
    case 65: // A
      movement.left = false;
      break;
    case 68: // D
      movement.right = false;
      break;
    case 87: // W
      movement.up = false;
      break;
    case 32: //space
      movement.shoot = false;
      break;
  }
});


socket.emit('new player');

setInterval(function() {
  socket.emit('movement', movement);
}, 1000 / FPS);




// currently this just displays all players in the game and their score
function drawScore(world, context) {
  context.textAlign = "left";

  context.font = "25px Impact";
  context.fillStyle = "gray";
  context.fillText('Active Players:', 10, 40);

  context.font = "15px Arial";
  let i = 0;
  for (var id in world.players) {
    const player = world.players[id];
    context.fillStyle = player.color;
    context.fillText(player.name + ": " + player.score, 10, i*20 + 60);
    i++;
  }
}
//draw those buggers
function drawRoids(world, context) {
  // set up asteroids
  createAsteroidBelt();
  function createAsteroidBelt() {
  var x, y;
  for (var i = 0; i < ROID_NUM; i++) {
      // random asteroid location (not touching spaceship)
      do {
        x = Math.floor(Math.random() * canvas.width);
        y = Math.floor(Math.random() * canvas.height);
      } while (distBetweenPoints(world.players.x, world.players.y, x, y) < ROID_SIZE * 2 + world.players.r);
        roids.push(newAsteroid(x, y));
      }
    }

  function distBetweenPoints(x1, y1, x2, y2) {
      return Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
  }

  function newAsteroid(x, y) {
      var roid = {
          a: Math.random() * Math.PI * 2, // in radians
          offs: [],
          r: ROID_SIZE / 2,
          vert: Math.floor(Math.random() * (ROID_VERT + 1) + ROID_VERT / 2),
          x: x,
          y: y,
          xv: Math.random() * ROID_SPD / 30 * (Math.random() < 0.5 ? 1 : -1),
          yv: Math.random() * ROID_SPD / 30 * (Math.random() < 0.5 ? 1 : -1)
      };
  // populate the offsets array
    for (var i = 0; i < roid.vert; i++) {
        roid.offs.push(Math.random() * ROID_JAG * 2 + 1 - ROID_JAG);
      }
      return roid;
  }

}




socket.on('state', function(world) {
  //context.clearRect(0, 0, 800, 600);
  context.fillStyle = "black";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.lineWidth =  SHIP_SIZE / 20;

  for (var id in world.players) {
  var player = world.players[id];
    // draw the thruster
    if (movement.up) {
        context.fillStyle = "red";
        context.strokeStyle = "yellow";
        context.beginPath();
        context.moveTo( // rear left
        player.x - player.r * (2 / 3 * Math.cos(player.a) + 0.5 * Math.sin(player.a)),
        player.y + player.r * (2 / 3 * Math.sin(player.a) - 0.5 * Math.cos(player.a))
          );
        context.lineTo( // rear centre (behind the player)
        player.x - player.r * 5 / 3 * Math.cos(player.a),
        player.y + player.r * 5 / 3 * Math.sin(player.a)
          );
        context.lineTo( // rear right
        player.x - player.r * (2 / 3 * Math.cos(player.a) - 0.5 * Math.sin(player.a)),
        player.y + player.r * (2 / 3 * Math.sin(player.a) + 0.5 * Math.cos(player.a))
          );
        context.closePath();
        context.fill();
        context.stroke()
      }
    context.strokeStyle = "white";
    context.beginPath();
    context.moveTo( //nose of the ship
      player.x + 4/3 * player.r * Math.cos(player.a),
      player.y - 4/3 * player.r * Math.sin(player.a)
    );
    context.lineTo( //rear left of ship
    player.x - player.r * (2/3 * Math.cos(player.a) + Math.sin(player.a)),
    player.y + player.r * (2/3 * Math.sin(player.a) - Math.cos(player.a))
    );
    context.lineTo( //rear right of ship
    player.x - player.r * (2/3 * Math.cos(player.a) - Math.sin(player.a)),
    player.y + player.r * (2/3 * Math.sin(player.a) + Math.cos(player.a))
    );
    context.closePath();
    context.stroke();
    //fill ship
    context.fillStyle = player.color;
    context.fill();

    context.font = "10px Arial";
    context.textAlign = "center";
    context.fillText(player.name, player.x, player.y + 50);

    drawScore(world, context);
    
    if (roids.length <= ROID_NUM) {
      drawRoids(world, context);
    }

  //Draw asteroids
  context.strokeStyle = "slategrey";
  context.lineWidth = SHIP_SIZE / 20;
  var a, r, x, y, offs, vert;
   for (var i = 0; i < roids.length; i++) {

      // get the asteroid properties
      a = roids[i].a;
      r = roids[i].r;
      x = roids[i].x;
      y = roids[i].y;
      offs = roids[i].offs;
      vert = roids[i].vert;

      // draw the path
      context.beginPath();
      context.moveTo(
          x + r * offs[0] * Math.cos(a),
          y + r * offs[0] * Math.sin(a)
      );
       // draw the polygon
      for (var j = 1; j < vert; j++) {
          context.lineTo(
              x + r * offs[j] * Math.cos(a + j * Math.PI * 2 / vert),
              y + r * offs[j] * Math.sin(a + j * Math.PI * 2 / vert)
          );
      }
      context.closePath();
      context.stroke();
// move the asteroid
      //setInterval(function() {
        roids[i].x += roids[i].xv;
        roids[i].y += roids[i].yv;
  //    }, 1000 / FPS);


        // handle asteroid edge of screen
        if (roids[i].x < 0 - roids[i].r) {
            roids[i].x = canvas.width + roids[i].r;
        } else if (roids[i].x > canvas.width + roids[i].r) {
            roids[i].x = 0 - roids[i].r
        }
        if (roids[i].y < 0 - roids[i].r) {
            roids[i].y = canvas.height + roids[i].r;
        } else if (roids[i].y > canvas.height + roids[i].r) {
            roids[i].y = 0 - roids[i].r
        }
    }
    // draw lasers
    const lasers = world.players[id].lasers;
    for (let i in lasers) {
      context.fillStyle = "white";
      context.beginPath();
      context.arc(player.lasers[i].x, player.lasers[i].y, SHIP_SIZE / 15, 0, Math.PI * 2, false);
      context.fill();
    }


  }

});
