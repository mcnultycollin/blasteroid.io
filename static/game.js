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
  //screen wrap
}, 1000 / 60);


// currently this just displays all players in the game
// in the future, we could make this show a scoreboard or something if we want
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
    context.fillText(player.name, 10, i*20 + 60);
    i++;
  }
}


var canvas = document.getElementById('canvas');
canvas.width = 800;
canvas.height = 600;
var context = canvas.getContext('2d');
socket.on('state', function(world) {
  context.clearRect(0, 0, 800, 600);
  context.fillStyle = 'green';
  context.strokeStyle = "black";
  context.lineWidth =  SHIP_SIZE / 20;
  for (var id in world.players) {
    var player = world.players[id];
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

    // draw lasers
    const lasers = world.players[id].lasers;
    for (let i in lasers) {
      context.fillStyle = "salmon";
      context.beginPath();
      context.arc(player.lasers[i].x, player.lasers[i].y, SHIP_SIZE / 15, 0, Math.PI * 2, false);
      context.fill();
    }
  }
//  for (var id in world.bullets)
// draw the lasers
//for (var id in world.players.lasers) {
  //        ctx.fillStyle = "salmon";
    //      ctx.beginPath();
      //    ctx.arc(player.lasers[i].x, player.lasers[i].y, SHIP_SIZE / 15, 0, Math.PI * 2, false);
        //  ctx.fill();
        //}
        //else {
// draw the eplosion
//          ctx.fillStyle = "orangered";
//          ctx.beginPath();
//          ctx.arc(player.lasers[i].x, player.lasers[i].y, player.r * 0.75, 0, Math.PI * 2, false);
//          ctx.fill();
//          ctx.fillStyle = "salmon";
//          ctx.beginPath();
//          ctx.arc(player.lasers[i].x, player.lasers[i].y, player.r * 0.5, 0, Math.PI * 2, false);
//          ctx.fill();
//          ctx.fillStyle = "pink";
//          ctx.beginPath();
//          ctx.arc(player.lasers[i].x, player.lasers[i].y, player.r * 0.25, 0, Math.PI * 2, false);
//          ctx.fill();
              //  }
          //  }
        //  }
});
