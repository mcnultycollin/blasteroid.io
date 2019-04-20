const TURN_SPEED = 180; //turn speed in degrees per second
const FPS = 30; //frame per second
const SHIP_THRUST = 10; //acceleration of ship in pixels per second per second
const FRICTION = 0.02;

// Dependencies
var express = require('express');
var http = require('http');
var path = require('path');
var socketIO = require('socket.io');
var app = express();
var server = http.Server(app);
var io = socketIO(server);
app.set('port', 8081);
app.use('/static', express.static(__dirname + '/static'));
// Routing
app.get('/', function(request, response) {
  response.sendFile(path.join(__dirname, 'index.html'));
});
// Starts the server.
server.listen(8081, function() {
  console.log('Starting server on port 5000');
});

// Add the WebSocket handlers
io.on('connection', function(socket) {
});
setInterval(function() {
  io.sockets.emit('message', 'hi!');
}, 1000);

var players = {};

var players = {};
io.on('connection', function(socket) {
  socket.on('new player', function() {
    players[socket.id] = {
      x: 300,
      y: 300,
      r: 30 / 2,
      a: 90 / 180 * Math.PI, //convert to radians
      rot: 0,
      thrusting: false,
      dx: 0,
      dy: 0
    };
  });
  socket.on('movement', function(data) {
    var player = players[socket.id] || {};
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
    player.x += player.dx;
    player.y += player.dy;
  });
});
setInterval(function() {
  io.sockets.emit('state', players);
}, 1000 / FPS);
