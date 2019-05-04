const TURN_SPEED = 180; //turn speed in degrees per second
const FPS = 30; //frame per second
const SHIP_THRUST = 10; //acceleration of ship in pixels per second per second
const FRICTION = 0.02;
const LASER_SPD = 500; // speed of lasers in pixels per second
const LASER_DIST = 0.6; // max distance laser can travel as fraction of screen width
const LASER_EXPLODE_DUR = 0.1; // duration of the lasers' explosion in seconds
const LASER_MAX = 10; // maximum number of lasers on screen at once

// Dependencies
var express = require('express');
var http = require('http');
var path = require('path');
var socketIO = require('socket.io');
var app = express();
var server = http.Server(app);
var io = socketIO(server);
app.set('port', 5000);
app.use('/static', express.static(__dirname + '/static'));
// Routing
app.get('/', function(request, response) {
  response.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/beta', function(request, response) {
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
    } else {
      player.dx = player.dx * (1-FRICTION);
      player.dy = player.dy * (1-FRICTION);
    }
    if (data.shoot) {
          io.sockets.emit('message', 'SHOOT');
          player.lasers.push({ // from the nose of the ship
              x: player.x + 4 / 3 * player.r * Math.cos(player.a),
              y: player.y - 4 / 3 * player.r * Math.sin(player.a),
              xv: LASER_SPD * Math.cos(player.a) / FPS,
              yv: -LASER_SPD * Math.sin(player.a) / FPS,
              dist: 0,
              explodeTime: 0
          });
      }

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
