var socket = io();
const FPS = 30; //frame per second
const SHIP_SIZE = 30; //ship height in pixels
const SHIP_THRUST = 5; //acceleration of ship in pixels per second per second

socket.on('message', function(data) {
  console.log(data);
});

var movement = {
  up: false,
  down: false,
  left: false,
  right: false
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
  }
});

socket.emit('new player');
setInterval(function() {
  socket.emit('movement', movement);
}, 1000 / 60);



var canvas = document.getElementById('canvas');
canvas.width = 800;
canvas.height = 600;
var context = canvas.getContext('2d');
socket.on('state', function(players) {
  context.clearRect(0, 0, 800, 600);
  context.fillStyle = 'green';
  context.strokeStyle = "black";
  context.lineWidth =  SHIP_SIZE / 20;
  for (var id in players) {
    var player = players[id];
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
    context.fillStyle = "blue";
    context.fill();
  }
});
